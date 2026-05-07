/**
 * pipeline/scraper.ts
 * Website scraping engine — fetches page HTML for a given business URL.
 *
 * Two paths:
 * - Static  → returns pre-fetched HTML string from detectPageType() via Cheerio
 * - Dynamic → launches Playwright, navigates with waitUntil:'domcontentloaded'
 *
 * Failure handling:
 * - HTTP 4xx/5xx → mark website_unreachable, increment metric, return unreachable
 * - Timeout → same
 * - Redirect to login page → same
 *
 * Phase 3.1 — Browser Context Pool (feature-flagged via BROWSER_POOL_ENABLED):
 * When enabled, maintains a pool of 2-3 browser contexts for concurrent scraping.
 * Each scrapeDynamic() call checks out a context from the pool, opens its own page,
 * and returns the context when done. Pool size is controlled by BROWSER_POOL_SIZE
 * (default: 2, max: 3 — increase only after memory profiling and CAPTCHA monitoring).
 * When disabled (default), falls back to the original single shared context.
 *
 * Phase 3.6 — Circuit Breaker for Failing Domains:
 * Tracks per-domain failure counts. After 3 consecutive failures, the domain is
 * skipped for 5 minutes. Prevents wasted retries on consistently failing sites.
 *
 * CONSTRAINTS:
 * - Returns HTML string only. No email/phone extraction here.
 * - No filtering here. No SSE lead events here.
 * - Scraper manages its own browser context, separate from the discovery browser.
 */

import * as cheerio from 'cheerio';
import { promises as dns } from 'dns';
import { Browser, BrowserContext } from 'playwright';
import { logger } from '../logger';
import { store } from '../store';
import { detectPageType, isLoginRedirect } from './detect';
import { createStealthBrowser } from './antiBlocking';
import { isAllowedByRobots } from './robots';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScrapeResult {
  html: string;
  finalUrl: string;
  unreachable: boolean;
  unreachableReason?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAYWRIGHT_LOAD_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS ?? '8000', 10);
const GLOBAL_SITE_TIMEOUT_MS = parseInt(process.env.GLOBAL_SITE_TIMEOUT_MS ?? '12000', 10);

/** B3: Maximum number of retries for timeout/5xx failures. */
const SCRAPE_MAX_RETRIES = parseInt(process.env.SCRAPE_MAX_RETRIES ?? '0', 10);

/** B3: Base delay in ms for exponential backoff between retries. */
const SCRAPE_RETRY_BASE_DELAY_MS = parseInt(process.env.SCRAPE_RETRY_BASE_DELAY_MS ?? '2000', 10);

// ─── Phase 3.6: Circuit Breaker ───────────────────────────────────────────────

interface CircuitEntry {
  failures: number;
  openedAt: number; // ms timestamp when circuit opened (0 = closed)
}

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const circuitBreaker = new Map<string, CircuitEntry>();

function getDomainKey(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Returns true if the circuit is open (domain should be skipped).
 * Auto-resets after CIRCUIT_OPEN_DURATION_MS.
 */
function isCircuitOpen(url: string): boolean {
  const key = getDomainKey(url);
  const entry = circuitBreaker.get(key);
  if (!entry || entry.openedAt === 0) return false;

  const elapsed = Date.now() - entry.openedAt;
  if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
    // Auto-reset after timeout
    circuitBreaker.set(key, { failures: 0, openedAt: 0 });
    logger.info(`Scraper: circuit reset for ${key} (was open for ${Math.round(elapsed / 1000)}s)`);
    return false;
  }
  return true;
}

/**
 * Records a failure for a domain. Opens the circuit after CIRCUIT_FAILURE_THRESHOLD.
 */
function recordDomainFailure(url: string): void {
  const key = getDomainKey(url);
  const entry = circuitBreaker.get(key) ?? { failures: 0, openedAt: 0 };
  entry.failures++;

  if (entry.failures >= CIRCUIT_FAILURE_THRESHOLD && entry.openedAt === 0) {
    entry.openedAt = Date.now();
    logger.warn(
      `Scraper: circuit opened for ${key} after ${entry.failures} failures — skipping for ${CIRCUIT_OPEN_DURATION_MS / 60000} min`
    );
  }

  circuitBreaker.set(key, entry);
}

/**
 * Records a success for a domain — resets failure count.
 */
function recordDomainSuccess(url: string): void {
  const key = getDomainKey(url);
  if (circuitBreaker.has(key)) {
    circuitBreaker.set(key, { failures: 0, openedAt: 0 });
  }
}

/** Clears the circuit breaker state. Useful for testing. */
export function clearCircuitBreaker(): void {
  circuitBreaker.clear();
}

/** Returns current circuit breaker stats for observability. */
export function getCircuitBreakerStats(): { total: number; open: number } {
  let open = 0;
  for (const entry of circuitBreaker.values()) {
    if (entry.openedAt !== 0) open++;
  }
  return { total: circuitBreaker.size, open };
}

// ─── Phase 3.1: Browser Context Pool ─────────────────────────────────────────

/**
 * Pool of browser contexts for concurrent scraping.
 * Gated behind BROWSER_POOL_ENABLED feature flag.
 * Pool size: 2-3 contexts (BROWSER_POOL_SIZE env var, default 2, max 3).
 *
 * Safety requirements before increasing pool size:
 * - Memory profiling to detect Playwright memory leaks
 * - CAPTCHA rate monitoring
 * - Production stability validation
 */
class BrowserContextPool {
  private pool: Array<{ browser: Browser; context: BrowserContext }> = [];
  private available: BrowserContext[] = [];
  private waitQueue: Array<(ctx: BrowserContext) => void> = [];
  private poolSize: number;
  private initialized = false;

  constructor(size: number) {
    // Enforce max pool size of 3 per plan requirements
    this.poolSize = Math.min(Math.max(1, size), 3);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    logger.info(`Scraper: initializing browser context pool (size=${this.poolSize})`);
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const { browser, context } = await createStealthBrowser({ ignoreHTTPSErrors: true });
        this.pool.push({ browser, context });
        this.available.push(context);
      } catch (err) {
        logger.warn(`Scraper: failed to create pool context ${i + 1} — ${(err as Error).message}`);
      }
    }
    logger.info(`Scraper: pool ready — ${this.available.length}/${this.poolSize} contexts available`);
  }

  async checkout(): Promise<BrowserContext> {
    if (this.available.length > 0) {
      return this.available.shift()!;
    }
    // Wait for a context to become available
    return new Promise<BrowserContext>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  checkin(context: BrowserContext): void {
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(context);
    } else {
      this.available.push(context);
    }
  }

  async closeAll(): Promise<void> {
    for (const { context, browser } of this.pool) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    this.pool = [];
    this.available = [];
    this.waitQueue = [];
    this.initialized = false;
    logger.info('Scraper: browser context pool closed');
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

let contextPool: BrowserContextPool | null = null;

function getPoolSize(): number {
  return parseInt(process.env.BROWSER_POOL_SIZE ?? '2', 10);
}

function isPoolEnabled(): boolean {
  return process.env.BROWSER_POOL_ENABLED === 'true';
}

async function getOrInitPool(): Promise<BrowserContextPool> {
  if (!contextPool) {
    contextPool = new BrowserContextPool(getPoolSize());
  }
  if (!contextPool.isInitialized()) {
    await contextPool.initialize();
  }
  return contextPool;
}

// ─── Scraper Browser (single-context fallback) ────────────────────────────────

/**
 * Single shared browser + context for all website scraping.
 * Used when BROWSER_POOL_ENABLED=false (default).
 * Each scrapeDynamic() call opens its own page and closes it when done.
 */
let scraperBrowser: Browser | null = null;
let scraperContext: BrowserContext | null = null;

async function getScraperContext(): Promise<BrowserContext> {
  if (!scraperBrowser || !scraperBrowser.isConnected()) {
    const { browser, context } = await createStealthBrowser({ ignoreHTTPSErrors: true });
    scraperBrowser = browser;
    scraperContext = context;
    return scraperContext;
  }
  if (!scraperContext) {
    const { context } = await createStealthBrowser({ ignoreHTTPSErrors: true });
    scraperContext = context;
  }
  return scraperContext;
}

export async function closeScraperBrowser(): Promise<void> {
  // Close pool if it was used
  if (contextPool && contextPool.isInitialized()) {
    await contextPool.closeAll();
    contextPool = null;
  }

  // Close single-context fallback
  try {
    if (scraperContext) {
      await scraperContext.close().catch(() => {});
      scraperContext = null;
    }
    if (scraperBrowser) {
      await scraperBrowser.close().catch(() => {});
      scraperBrowser = null;
    }
    logger.info('Scraper: browser closed');
  } catch (err) {
    logger.warn(`Scraper: error closing browser — ${(err as Error).message}`);
  }
}

// ─── Unreachable Helper ───────────────────────────────────────────────────────

function markUnreachable(url: string, reason: string): ScrapeResult {
  logger.info(`Scraper: unreachable — ${url} (${reason})`);
  store.incrementMetric('website_unreachable');
  return { html: '', finalUrl: url, unreachable: true, unreachableReason: reason };
}

// ─── Static Path (Cheerio) ────────────────────────────────────────────────────

function scrapeStatic(url: string, html: string): ScrapeResult {
  if (!html || html.trim().length === 0) {
    return markUnreachable(url, 'empty static HTML');
  }
  logger.info(`Scraper: static path — ${url} (${html.length} bytes)`);
  return { html, finalUrl: url, unreachable: false };
}

// ─── Dynamic Path (Playwright) ────────────────────────────────────────────────

/**
 * Fetches a dynamic page using Playwright.
 * Phase 3.1: uses browser context pool when BROWSER_POOL_ENABLED=true,
 * otherwise falls back to single shared context.
 * Each call creates its own page and closes it on completion.
 * A global timeout races against the Playwright work to cap per-site time.
 */
async function scrapeDynamic(url: string): Promise<ScrapeResult> {
  logger.info(`Scraper: dynamic path — ${url}`);

  let globalTimerHandle: ReturnType<typeof setTimeout> | null = null;

  const globalTimer = new Promise<ScrapeResult>((resolve) => {
    globalTimerHandle = setTimeout(
      () => resolve(markUnreachable(url, `global timeout ${GLOBAL_SITE_TIMEOUT_MS}ms`)),
      GLOBAL_SITE_TIMEOUT_MS
    );
  });

  const scrapeWork = async (): Promise<ScrapeResult> => {
    let ctx: BrowserContext;
    let fromPool = false;

    try {
      if (isPoolEnabled()) {
        const pool = await getOrInitPool();
        ctx = await pool.checkout();
        fromPool = true;
      } else {
        ctx = await getScraperContext();
      }
    } catch (err) {
      return markUnreachable(url, `browser init failed: ${(err as Error).message}`);
    }

    let page;
    try {
      page = await ctx.newPage();
    } catch (err) {
      if (fromPool) contextPool?.checkin(ctx);
      const msg = (err as Error).message ?? '';
      return markUnreachable(url, `newPage failed: ${msg.slice(0, 120)}`);
    }
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PLAYWRIGHT_LOAD_TIMEOUT_MS,
      });

      const status = response?.status() ?? 0;
      if (status >= 400) {
        return markUnreachable(url, `HTTP ${status}`);
      }

      const finalUrl = page.url();
      if (isLoginRedirect(finalUrl)) {
        return markUnreachable(url, 'login redirect');
      }

      // Brief settle for JS-rendered content
      await page.waitForTimeout(600);

      const html = await page.content();
      logger.info(`Scraper: dynamic fetched — ${url} (${html.length} bytes)`);
      return { html, finalUrl, unreachable: false };
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // Browser/context closed — non-retryable, return cleanly without crashing
      if (
        msg.includes('Target page, context or browser has been closed') ||
        msg.includes('browser has been closed') ||
        msg.includes('context has been closed') ||
        msg.includes('Target closed') ||
        msg.includes('cdpSession.send')
      ) {
        return markUnreachable(url, 'browser context closed');
      }
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        return markUnreachable(url, 'Playwright timeout');
      }
      return markUnreachable(url, msg.slice(0, 120));
    } finally {
      await page?.close().catch(() => {});
      if (fromPool && ctx!) contextPool?.checkin(ctx!);
    }
  };

  return Promise.race([scrapeWork(), globalTimer]).then((result) => {
    // Cancel the global timer if scrapeWork won — prevents stale timeout
    // logs appearing after the browser is closed by the next city job.
    if (globalTimerHandle !== null) clearTimeout(globalTimerHandle);
    return result;
  });
}

// ─── B3: Retry helper ─────────────────────────────────────────────────────────

/**
 * Returns true only for transient site failures worth retrying.
 * Browser/context lifecycle errors are NOT retryable — the browser was
 * intentionally closed and retrying would crash the process.
 */
function isRetryableReason(reason: string): boolean {
  // Never retry browser infrastructure failures
  const browserClosed =
    reason.includes('Target page, context or browser has been closed') ||
    reason.includes('browser has been closed') ||
    reason.includes('context has been closed') ||
    reason.includes('Target closed') ||
    reason.includes('browser init failed');

  if (browserClosed) return false;

  // Only retry on transient site-side failures
  return (
    reason.includes('timeout') ||
    reason.includes('Timeout') ||
    reason.includes('HTTP 5')
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function scrapePage(url: string): Promise<ScrapeResult> {
  if (!url || url.trim().length === 0) {
    return { html: '', finalUrl: '', unreachable: true };
  }

  // ── Phase 3.6: Circuit breaker check ─────────────────────────────────────
  if (isCircuitOpen(url)) {
    const key = getDomainKey(url);
    logger.info(`Scraper: circuit open for ${key} — skipping ${url}`);
    store.incrementMetric('website_unreachable');
    return { html: '', finalUrl: url, unreachable: true, unreachableReason: `circuit open for ${key}` };
  }

  // ── Robots check ─────────────────────────────────────────────────────────
  const allowed = await isAllowedByRobots(url);
  if (!allowed) {
    logger.info(`Scraper: skipped (robots.txt disallowed) — ${url}`);
    store.incrementMetric('website_unreachable');
    return { html: '', finalUrl: url, unreachable: true, unreachableReason: 'robots.txt disallowed' };
  }

  // ── B1: DNS pre-resolution ────────────────────────────────────────────────
  try {
    const hostname = new URL(url).hostname;
    await dns.resolve(hostname);
  } catch {
    logger.info(`Scraper: DNS resolution failed — ${url}`);
    store.incrementMetric('website_unreachable');
    recordDomainFailure(url);
    return { html: '', finalUrl: url, unreachable: true, unreachableReason: 'DNS resolution failed' };
  }

  // ── B3: Retry loop ────────────────────────────────────────────────────────
  let lastResult: ScrapeResult = { html: '', finalUrl: url, unreachable: true };

  for (let attempt = 0; attempt <= SCRAPE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Phase 2.4: exponential backoff + random jitter to prevent retry stampedes
      const baseDelay = SCRAPE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * baseDelay * 0.3); // ±30% jitter
      const delayMs = baseDelay + jitter;
      logger.info(`Scraper: retry ${attempt}/${SCRAPE_MAX_RETRIES} for ${url} (delay ${delayMs}ms)`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }

    try {
      const detection = await detectPageType(url);

      if (detection.pageType === 'static') {
        if (!detection.html) {
          lastResult = markUnreachable(url, 'static detection returned no HTML');
        } else {
          lastResult = scrapeStatic(url, detection.html);
        }
      } else {
        lastResult = await scrapeDynamic(url);
      }
    } catch (err) {
      lastResult = markUnreachable(url, (err as Error).message);
    }

    if (!lastResult.unreachable) {
      // Phase 3.6: record success — reset failure count
      recordDomainSuccess(url);
      return lastResult;
    }

    // Phase 3.6: record failure for circuit breaker
    recordDomainFailure(url);

    const reason = lastResult.unreachableReason ?? '';
    if (!isRetryableReason(reason)) {
      // Non-retryable failure — return immediately
      return lastResult;
    }
  }

  return lastResult;
}

/**
 * D1: Extracts internal links matching contact/about patterns from page HTML.
 * Links are scored by URL path and anchor text relevance.
 * Used by the in-depth crawl module.
 */
export function extractContactSubPageUrls(html: string, baseUrl: string): string[] {
  const CONTACT_PATTERNS = [
    '/contact', '/contact-us', '/contacts', '/reach-us', '/get-in-touch',
    '/about', '/about-us', '/our-team', '/team', '/staff', '/people',
    '/leadership', '/management', '/founders', '/meet-the-team',
  ];

  try {
    const base = new URL(baseUrl);
    const $ = cheerio.load(html);
    const scored = new Map<string, number>();

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const anchorText = $(el).text().toLowerCase().trim();
      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.hostname !== base.hostname) return;
        const pathname = resolved.pathname.toLowerCase();
        if (!CONTACT_PATTERNS.some((p) => pathname.startsWith(p))) return;

        const normUrl = resolved.href.replace(/\/$/, '');
        let score = scored.get(normUrl) ?? 0;

        // URL-based scoring
        if (pathname.includes('contact')) score += 30;
        else if (pathname.includes('about')) score += 20;
        else if (pathname.includes('team') || pathname.includes('staff')) score += 15;
        else if (pathname.includes('leadership')) score += 10;

        // Anchor text scoring
        if (anchorText.includes('contact')) score += 25;
        else if (
          anchorText.includes('email') ||
          anchorText.includes('reach') ||
          anchorText.includes('get in touch')
        ) score += 20;
        else if (anchorText.includes('about')) score += 15;
        else if (anchorText.includes('team') || anchorText.includes('people')) score += 10;

        scored.set(normUrl, score);
      } catch {
        // ignore unparseable hrefs
      }
    });

    return [...scored.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([url]) => url);
  } catch {
    return [];
  }
}

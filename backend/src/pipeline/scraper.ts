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
const SCRAPE_MAX_RETRIES = parseInt(process.env.SCRAPE_MAX_RETRIES ?? '2', 10);

/** B3: Base delay in ms for exponential backoff between retries. */
const SCRAPE_RETRY_BASE_DELAY_MS = parseInt(process.env.SCRAPE_RETRY_BASE_DELAY_MS ?? '2000', 10);

// ─── Scraper Browser ──────────────────────────────────────────────────────────

/**
 * Single shared browser + context for all website scraping.
 * Each scrapeDynamic() call opens its own page and closes it when done.
 * No page pool — avoids shared-state crashes under concurrency.
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
 * Each call creates its own page and closes it on completion — no shared page state.
 * A global timeout races against the Playwright work to cap per-site time.
 */
async function scrapeDynamic(url: string): Promise<ScrapeResult> {
  logger.info(`Scraper: dynamic path — ${url}`);

  const globalTimer = new Promise<ScrapeResult>((resolve) =>
    setTimeout(
      () => resolve(markUnreachable(url, `global timeout ${GLOBAL_SITE_TIMEOUT_MS}ms`)),
      GLOBAL_SITE_TIMEOUT_MS
    )
  );

  const scrapeWork = async (): Promise<ScrapeResult> => {
    let ctx: BrowserContext;
    try {
      ctx = await getScraperContext();
    } catch (err) {
      return markUnreachable(url, `browser init failed: ${(err as Error).message}`);
    }

    const page = await ctx.newPage().catch((err) => {
      throw new Error(`newPage failed: ${(err as Error).message}`);
    });

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
      const msg = (err as Error).message;
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        return markUnreachable(url, 'Playwright timeout');
      }
      return markUnreachable(url, msg.slice(0, 120));
    } finally {
      await page.close().catch(() => {});
    }
  };

  return Promise.race([scrapeWork(), globalTimer]);
}

// ─── B3: Retry helper ─────────────────────────────────────────────────────────

function isRetryableReason(reason: string): boolean {
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
    return { html: '', finalUrl: url, unreachable: true, unreachableReason: 'DNS resolution failed' };
  }

  // ── B3: Retry loop ────────────────────────────────────────────────────────
  let lastResult: ScrapeResult = { html: '', finalUrl: url, unreachable: true };

  for (let attempt = 0; attempt <= SCRAPE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = SCRAPE_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
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

    if (!lastResult.unreachable) return lastResult;

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

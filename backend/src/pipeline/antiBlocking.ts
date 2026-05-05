/**
 * pipeline/antiBlocking.ts
 * Anti-blocking utilities — Phase 9.
 *
 * Provides:
 * 1. createStealthBrowser() — launches a Playwright browser with stealth plugin
 *    and a randomised fingerprint (UA, viewport, locale, extra headers).
 * 2. pickUserAgent() — returns a random UA from the pool.
 * 3. pickViewport() — returns a random viewport from the pool.
 * 4. getProxyConfig() — reads PROXY_URL from env and returns Playwright proxy config.
 *
 * Used by discovery.ts and scraper.ts at their browser-launch call sites.
 * All other logic in those modules is unchanged.
 *
 * CONSTRAINTS:
 * - Existing delays and jitter in discovery.ts are preserved.
 * - No paid proxy services — PROXY_URL is optional and env-controlled.
 * - Budget: $0 (no proxy) or up to $5–6/month if PROXY_URL is set.
 */

import { chromium as playwrightChromium } from 'playwright';
import { logger } from '../logger';

// ─── Try to load playwright-extra + stealth ───────────────────────────────────
// Wrapped in try/catch so the system degrades gracefully if the package is
// not installed (e.g. in CI or minimal environments).

let stealthChromium: typeof playwrightChromium | null = null;

async function loadStealthChromium(): Promise<typeof playwrightChromium> {
  if (stealthChromium) return stealthChromium;

  try {
    // Dynamic import to avoid hard dependency at module load time
    const { chromium: extra } = await import('playwright-extra');
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    extra.use(StealthPlugin());
    stealthChromium = extra as unknown as typeof playwrightChromium;
    logger.info('AntiBlocking: stealth plugin loaded');
    return stealthChromium;
  } catch (err) {
    logger.warn(
      `AntiBlocking: playwright-extra not available (${(err as Error).message}) — falling back to plain Playwright`
    );
    stealthChromium = playwrightChromium;
    return stealthChromium;
  }
}

// ─── User-Agent Pool ──────────────────────────────────────────────────────────

/**
 * Pool of real browser user-agent strings.
 * Rotated per browser launch to vary the fingerprint.
 */
const USER_AGENTS: string[] = [
  // Chrome on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  // Chrome on macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Firefox on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  // Edge on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  // Chrome on Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

/** Returns a random user-agent string from the pool. */
export function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Viewport Pool ────────────────────────────────────────────────────────────

const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
];

/** Returns a random viewport from the pool. */
export function pickViewport(): { width: number; height: number } {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// ─── Extra Headers ────────────────────────────────────────────────────────────

/**
 * Returns a set of extra HTTP headers that mimic a real browser.
 * These are added to every request made by the browser context.
 */
export function getExtraHeaders(): Record<string, string> {
  return {
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

// ─── Proxy Configuration ──────────────────────────────────────────────────────

/**
 * Reads PROXY_URL from the environment and returns a Playwright proxy config.
 * Returns undefined if PROXY_URL is not set or is empty.
 *
 * Supported formats:
 *   http://user:pass@proxy.example.com:8080
 *   http://proxy.example.com:8080
 *   socks5://proxy.example.com:1080
 */
export function getProxyConfig():
  | { server: string; username?: string; password?: string }
  | undefined {
  const proxyUrl = process.env.PROXY_URL?.trim();
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    const config: { server: string; username?: string; password?: string } = {
      server: `${parsed.protocol}//${parsed.host}`,
    };
    if (parsed.username) config.username = decodeURIComponent(parsed.username);
    if (parsed.password) config.password = decodeURIComponent(parsed.password);
    logger.info(`AntiBlocking: proxy configured — ${parsed.protocol}//${parsed.host}`);
    return config;
  } catch {
    logger.warn(`AntiBlocking: invalid PROXY_URL "${proxyUrl}" — proxy disabled`);
    return undefined;
  }
}

// ─── Stealth Browser Factory ──────────────────────────────────────────────────

export interface StealthBrowserOptions {
  /** Override user-agent (defaults to random pick from pool). */
  userAgent?: string;
  /** Override viewport (defaults to random pick from pool). */
  viewport?: { width: number; height: number };
  /** Whether to ignore HTTPS errors (default: false). */
  ignoreHTTPSErrors?: boolean;
}

/**
 * Launches a Playwright Chromium browser with:
 * - Stealth plugin (playwright-extra + puppeteer-extra-plugin-stealth)
 * - Randomised user-agent from the pool
 * - Randomised viewport from the pool
 * - Extra headers mimicking a real browser
 * - Optional proxy from PROXY_URL env variable
 *
 * Falls back to plain Playwright if playwright-extra is not installed.
 *
 * @returns { browser, context } — caller is responsible for closing both.
 */
export async function createStealthBrowser(opts: StealthBrowserOptions = {}): Promise<{
  browser: Awaited<ReturnType<typeof playwrightChromium.launch>>;
  context: Awaited<ReturnType<Awaited<ReturnType<typeof playwrightChromium.launch>>['newContext']>>;
}> {
  const chromium = await loadStealthChromium();
  const proxy = getProxyConfig();
  const userAgent = opts.userAgent ?? pickUserAgent();
  const viewport = opts.viewport ?? pickViewport();

  logger.info(
    `AntiBlocking: launching browser — UA="${userAgent.slice(0, 60)}..." ` +
    `viewport=${viewport.width}x${viewport.height} proxy=${proxy ? proxy.server : 'none'}`
  );

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
    ],
    ...(proxy ? { proxy } : {}),
  });

  const context = await browser.newContext({
    userAgent,
    viewport,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ignoreHTTPSErrors: opts.ignoreHTTPSErrors ?? false,
    extraHTTPHeaders: getExtraHeaders(),
    ...(proxy ? { proxy } : {}),
  });

  // Mask navigator.webdriver via init script (belt-and-suspenders alongside stealth plugin)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });

  return { browser, context };
}

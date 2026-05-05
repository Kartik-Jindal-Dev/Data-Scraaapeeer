/**
 * pipeline/detect.ts
 * Static vs dynamic page detection.
 *
 * Strategy:
 * 1. Send a GET request with a 2-second timeout.
 * 2. Inspect the response HTML for JS framework markers.
 * 3. If no markers found AND response arrived in <2s → 'static' (use Cheerio).
 * 4. If markers found OR request timed out/failed → 'dynamic' (use Playwright).
 *
 * Returns the fetched HTML alongside the classification so the Cheerio path
 * can reuse it without a second network request.
 */

import { logger } from '../logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PageType = 'static' | 'dynamic';

export interface DetectionResult {
  pageType: PageType;
  /** Pre-fetched HTML string. Only populated for 'static' pages. Empty string for 'dynamic'. */
  html: string;
}

// ─── JS Framework Markers ─────────────────────────────────────────────────────

/**
 * Substrings that indicate a JS-rendered page.
 * Checked case-insensitively against the raw HTML.
 */
const JS_FRAMEWORK_MARKERS: string[] = [
  '__next_data__',
  'react',
  'vue',
  'angular',
  'ng-version',
  'nuxt',
  '__nuxt__',
  'svelte',
  'gatsby',
];

/** Hostname suffixes that are always static — skip detection fetch, use Cheerio. */
const ALWAYS_STATIC_PATTERNS: string[] = [
  'github.io',
  'netlify.app',
  'pages.dev',
  'surge.sh',
  'tiiny.site',
];

/** Hostname substrings that are always dynamic — skip detection fetch, use Playwright. */
const ALWAYS_DYNAMIC_PATTERNS: string[] = [
  'myshopify.com',
  'squarespace.com',
  'webflow.io',
  'wixsite.com',
  'weebly.com',
  'godaddysites.com',
  'sites.google.com',
];

// ─── Login / Auth Redirect Detection ─────────────────────────────────────────

/**
 * Patterns in the final URL that indicate a redirect to a login or auth page.
 * If detected, the site is treated as unreachable.
 */
const LOGIN_URL_PATTERNS: string[] = [
  '/login',
  '/signin',
  '/sign-in',
  '/auth',
  '/account/login',
  '/wp-login',
];

export function isLoginRedirect(url: string): boolean {
  const lower = url.toLowerCase();
  return LOGIN_URL_PATTERNS.some((p) => lower.includes(p));
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 3s default — balances speed vs. high-latency sites (India, SE Asia).
// 1s was too aggressive: most sites timed out and fell through to Playwright unnecessarily.
// Configurable via DETECTION_TIMEOUT_MS env var.
const DETECTION_TIMEOUT_MS = parseInt(process.env.DETECTION_TIMEOUT_MS ?? '3000', 10);

// ─── Heuristic Page Type Detection ───────────────────────────────────────────

/**
 * Returns a PageType based on hostname patterns without making a network request.
 * Returns null if no heuristic matches (proceed with normal detection).
 */
function getHeuristicPageType(url: string): PageType | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (ALWAYS_STATIC_PATTERNS.some((p) => hostname.endsWith(p))) {
      return 'static';
    }

    if (ALWAYS_DYNAMIC_PATTERNS.some((p) => hostname.includes(p))) {
      return 'dynamic';
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Main Detection Function ──────────────────────────────────────────────────

/**
 * Determines whether a URL points to a static or dynamic page.
 *
 * Returns:
 * - { pageType: 'static', html: '<fetched html>' } — use Cheerio
 * - { pageType: 'dynamic', html: '' }              — use Playwright
 *
 * Never throws. All errors result in 'dynamic' classification.
 */
export async function detectPageType(url: string): Promise<DetectionResult> {
  if (!url || url.trim().length === 0) {
    return { pageType: 'dynamic', html: '' };
  }

  // ── B2: Heuristic fast-path ───────────────────────────────────────────────
  const heuristic = getHeuristicPageType(url);
  if (heuristic === 'static') {
    logger.info(`detect: heuristic static match for ${url} → static`);
    return { pageType: 'static', html: '' };
  }
  if (heuristic === 'dynamic') {
    logger.info(`detect: heuristic dynamic match for ${url} → dynamic`);
    return { pageType: 'dynamic', html: '' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECTION_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    // Non-2xx → treat as unreachable (caller handles this)
    if (!res.ok) {
      logger.info(`detect: HTTP ${res.status} for ${url} → dynamic`);
      return { pageType: 'dynamic', html: '' };
    }

    // Login redirect check on final URL
    if (isLoginRedirect(res.url)) {
      logger.info(`detect: login redirect detected for ${url} → dynamic`);
      return { pageType: 'dynamic', html: '' };
    }

    const html = await res.text();
    const lower = html.toLowerCase();

    const hasDynamicMarker = JS_FRAMEWORK_MARKERS.some((marker) =>
      lower.includes(marker)
    );

    if (hasDynamicMarker) {
      logger.info(`detect: JS framework marker found for ${url} → dynamic`);
      return { pageType: 'dynamic', html: '' };
    }

    logger.info(`detect: static page confirmed for ${url}`);
    return { pageType: 'static', html };
  } catch (err) {
    clearTimeout(timer);
    const reason = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
    logger.info(`detect: fetch failed (${reason}) for ${url} → dynamic`);
    return { pageType: 'dynamic', html: '' };
  }
}

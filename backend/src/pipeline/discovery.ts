/**
 * pipeline/discovery.ts
 * Business discovery via Playwright on Google Maps.
 *
 * FREE STACK: No Outscraper API. No paid services.
 * Primary source: https://www.google.com/maps/search/<keyword>+<location>
 *
 * Strategy (Tier 2.1 — inline list extraction):
 * 1. Navigate to Google Maps search URL.
 * 2. Wait for the results feed using multiple selector fallbacks.
 * 3. Scroll the feed to load up to MAX_LEADS results.
 * 4. Extract name, address, phone, website DIRECTLY from the list items.
 * 5. For results missing both phone AND website, click through to the detail panel.
 * 6. Apply delay only between fallback detail-panel navigations.
 * 7. Detect CAPTCHA — if found, increment metric, emit SSE error, stop safely.
 *
 * Feed selector fallback strategy:
 * Google occasionally changes the Maps DOM. The scraper tries multiple known
 * selectors in parallel and uses whichever one appears first. If none match,
 * it retries once with a different URL format before giving up.
 *
 * CONSTRAINTS:
 * - Do NOT filter leads here — all raw leads pass through to deduplicator.
 * - Do NOT scrape websites here — discovery only (name, address, phone, website).
 * - LinkedIn is excluded from all discovery sources.
 */

import { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../logger';
import { store } from '../store';
import { emitError, emitStatus } from '../sse';
import { RawLead } from '../types';
import { createStealthBrowser } from './antiBlocking';
import { searchSerper, convertToRawLeads, validateSerperResults } from './serper';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN ?? '100', 10);
const BASE_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS ?? '500', 10);
const JITTER_MS = parseInt(process.env.REQUEST_DELAY_JITTER_MS ?? '200', 10);
const FEED_TIMEOUT_MS = 20_000;
const SCROLL_PAUSE_MS = 1_200;

// Maps discovery cap: how many results to scroll to per city.
// Serper mode ignores this (controlled by SERPER_RESULTS_PER_QUERY).
// Maps mode: 30 is enough — after dedup removes directory sites you get ~15–20
// real businesses. Scrolling to 100+ wastes 40–60 extra seconds per city.
const MAPS_RESULTS_CAP = parseInt(process.env.MAPS_RESULTS_CAP ?? '30', 10);

/**
 * Ordered list of CSS selectors that may contain the Maps results feed.
 * Tried in parallel — whichever resolves first is used for the entire run.
 *
 * 1. [role="feed"]                — standard ARIA feed (current Maps layout)
 * 2. div[aria-label*="Results for"] — alternate ARIA label in some locales
 * 3. div[aria-label*="results"]   — lowercase variant
 * 4. .m6QErb[aria-label]          — Maps-specific class in some A/B variants
 * 5. #QA0Szd                      — outer panel container (last resort)
 */
const FEED_SELECTORS = [
  '[role="feed"]',
  'div[aria-label*="Results for"]',
  'div[aria-label*="results"]',
  '.m6QErb[aria-label]',
  '#QA0Szd',
];

// ─── Shared Browser State ─────────────────────────────────────────────────────

let activeBrowser: Browser | null = null;
let activeContext: BrowserContext | null = null;

export function getActiveContext(): BrowserContext | null {
  return activeContext;
}

export async function forceCloseBrowser(): Promise<void> {
  try {
    if (activeContext) {
      await activeContext.close().catch(() => {});
      activeContext = null;
    }
    if (activeBrowser) {
      await activeBrowser.close().catch(() => {});
      activeBrowser = null;
    }
    logger.info('Discovery: browser force-closed');
  } catch (err) {
    logger.warn(`Discovery: error during force-close — ${(err as Error).message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDelay(): Promise<void> {
  const ms = BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseUrl(raw: string): string {
  if (!raw || raw.trim().length === 0) return '';
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  url = url.replace(/\/$/, '');

  // Filter out Google Ads click-tracking URLs (/aclk) and other non-business URLs.
  // These appear when Maps shows sponsored results — they redirect to the real site
  // but the redirect target is unpredictable and wastes a browser slot.
  const BLOCKED_URL_PATTERNS = [
    'google.com/aclk',
    'google.com/pagead',
    'googleadservices.com',
    'doubleclick.net',
    'facebook.com',
    'instagram.com',
    'twitter.com',
    'linkedin.com',
    'youtube.com',
    'yelp.com',
    'bbb.org',
    'reddit.com',
    'yellowpages.com',
    'homestars.com',
    'bark.com',
    'houzz.com',
    'thumbtack.com',
    'angi.com',
    'angieslist.com',
    'homeadvisor.com',
  ];

  if (BLOCKED_URL_PATTERNS.some((p) => url.includes(p))) return '';

  return url;
}

// ─── CAPTCHA Detection ────────────────────────────────────────────────────────

async function isCaptchaPage(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/sorry/') || url.includes('google.com/sorry')) return true;
    const hasCaptchaForm = await page.$('form#captcha-form').then((el) => !!el);
    const hasRecaptcha = await page.$('iframe[src*="recaptcha"]').then((el) => !!el);
    return hasCaptchaForm || hasRecaptcha;
  } catch {
    return false;
  }
}

// ─── Consent Dialog Handler ───────────────────────────────────────────────────

async function dismissConsentDialog(page: Page): Promise<void> {
  try {
    const selectors = [
      'button[aria-label*="Accept all"]',
      'button[aria-label*="Accept"]',
      'button[jsname="higCR"]',
      'form[action*="consent"] button[type="submit"]',
      '#L2AGLb',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1_200);
        logger.info('Discovery: dismissed consent dialog');
        return;
      }
    }
  } catch {
    // No dialog — continue
  }
}

// ─── Feed Selector Helpers ────────────────────────────────────────────────────

/**
 * Waits for any of the known feed selectors to appear on the page.
 * Runs all selectors in parallel — returns the first one that resolves.
 * Returns null if none appear within timeoutMs.
 */
async function waitForFeed(page: Page, timeoutMs: number): Promise<string | null> {
  const results = await Promise.all(
    FEED_SELECTORS.map((sel) =>
      page.waitForSelector(sel, { timeout: timeoutMs })
        .then(() => sel)
        .catch(() => null as string | null)
    )
  );
  return results.find((r) => r !== null) ?? null;
}

/**
 * Scrolls the feed element identified by feedSelector.
 * Falls back to window.scrollBy if the element is not found.
 */
async function scrollFeed(page: Page, feedSelector: string): Promise<void> {
  await page.evaluate((sel) => {
    const feed = document.querySelector(sel);
    if (feed) feed.scrollBy(0, 1000);
    else window.scrollBy(0, 1000);
  }, feedSelector);
}

/**
 * Counts result cards inside the feed.
 * Tries direct div children first, then place-link anchors as a fallback.
 */
async function countFeedItems(page: Page, feedSelector: string): Promise<number> {
  return page.evaluate((sel) => {
    const feed = document.querySelector(sel);
    if (!feed) return 0;
    const direct = feed.querySelectorAll(':scope > div');
    if (direct.length > 0) return direct.length;
    return feed.querySelectorAll('a[href*="/maps/place/"]').length;
  }, feedSelector).catch(() => 0);
}

/**
 * Phase 3.4: Waits for feed item count to stabilize after a scroll.
 * Polls every 200ms until count stops changing or maxWaitMs is reached.
 * Returns the final stable count.
 */
async function waitForFeedStable(
  page: Page,
  feedSelector: string,
  prevCount: number,
  maxWaitMs: number
): Promise<number> {
  const startTime = Date.now();
  let currentCount = prevCount;
  let stableCount = prevCount;
  let stableFor = 0;

  while (Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(200);
    currentCount = await countFeedItems(page, feedSelector);

    if (currentCount === stableCount) {
      stableFor += 200;
      if (stableFor >= 600) {
        // Stable for 600ms — consider it done
        return currentCount;
      }
    } else {
      stableCount = currentCount;
      stableFor = 0;
    }
  }

  return currentCount;
}

// ─── Inline List Extraction ───────────────────────────────────────────────────

interface InlineResult {
  name: string;
  address: string;
  rawPhone: string;
  website: string;
  placeUrl: string;
}

/**
 * Extracts all available data directly from the Maps search results list.
 * Works with any feed selector variant — no hardcoded [role="feed"].
 */
async function extractFromList(page: Page, feedSelector: string): Promise<InlineResult[]> {
  return page.evaluate((sel) => {
    const feed = document.querySelector(sel);
    if (!feed) return [];

    // Collect card elements — direct div children first, then place-link ancestors
    let cards: Element[] = Array.from(feed.querySelectorAll(':scope > div'));
    if (cards.length === 0) {
      const placeLinks = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
      const seen = new Set<Element>();
      for (const link of placeLinks) {
        const ancestor = link.closest('[jsaction]') ?? link.parentElement ?? link;
        if (!seen.has(ancestor)) { seen.add(ancestor); cards.push(ancestor); }
      }
    }

    const results: Array<{
      name: string; address: string; rawPhone: string; website: string; placeUrl: string;
    }> = [];

    for (const card of cards) {
      const name =
        card.querySelector('.fontHeadlineSmall')?.textContent?.trim() ||
        card.querySelector('[class*="fontHeadline"]')?.textContent?.trim() ||
        card.querySelector('span[aria-label]')?.getAttribute('aria-label')?.trim() ||
        card.querySelector('h3')?.textContent?.trim() ||
        '';

      if (!name || name.toLowerCase() === 'results') continue;

      const addressSpans = card.querySelectorAll('.W4Efsd span');
      let address = '';
      for (const span of Array.from(addressSpans)) {
        const text = span.textContent?.trim() ?? '';
        if (text && !text.startsWith('·') && text.length > 5 && /\d|road|street|sector|nagar|colony|block/i.test(text)) {
          address = text; break;
        }
      }
      if (!address) address = card.querySelector('.W4Efsd')?.textContent?.trim() ?? '';

      let rawPhone = '';
      for (const span of Array.from(card.querySelectorAll('span'))) {
        const text = span.textContent?.trim() ?? '';
        if (/^[+\d][\d\s\-().]{6,14}$/.test(text)) { rawPhone = text; break; }
      }

      const websiteAnchor =
        (card.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null) ||
        (card.querySelector('a[aria-label*="website" i]') as HTMLAnchorElement | null) ||
        (card.querySelector('a[aria-label*="Website"]') as HTMLAnchorElement | null);
      const website = websiteAnchor?.href ?? '';

      const placeAnchor = card.querySelector('a[href*="/maps/place/"]') as HTMLAnchorElement | null;
      const placeUrl = placeAnchor?.href ?? '';

      results.push({ name, address, rawPhone, website, placeUrl });
    }

    return results;
  }, feedSelector).catch(() => []);
}

// ─── Detail Panel Extraction (fallback for missing phone/website) ─────────────

async function extractFromDetailPanel(
  page: Page,
  placeUrl: string
): Promise<{ rawPhone: string; website: string } | null> {
  try {
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    await page.waitForSelector('h1', { timeout: 5_000 });
    await page.waitForTimeout(300);

    const rawPhone =
      (await page.$eval('button[data-item-id^="phone:tel:"] .Io6YTe', (el) => el.textContent?.trim() ?? '').catch(() => '')) ||
      (await page.$eval('[data-tooltip="Copy phone number"] .Io6YTe', (el) => el.textContent?.trim() ?? '').catch(() => '')) ||
      '';

    const rawWebsite =
      (await page.$eval('a[data-item-id="authority"]', (el) => (el as HTMLAnchorElement).href ?? '').catch(() => '')) ||
      (await page.$eval('a[aria-label^="Website"]', (el) => (el as HTMLAnchorElement).href ?? '').catch(() => '')) ||
      '';

    return { rawPhone, website: rawWebsite };
  } catch (err) {
    logger.warn(`Discovery: detail panel fallback failed for ${placeUrl} — ${(err as Error).message}`);
    return null;
  }
}

// ─── Main Discovery Function ──────────────────────────────────────────────────

export async function discoverLeads(
  jobId: string,
  keyword: string,
  location: string,
  stopSignal: { stopped: boolean }
): Promise<RawLead[]> {
  const rawLeads: RawLead[] = [];
  const searchQuery = encodeURIComponent(`${keyword} ${location}`);
  
  // Start timing for observability
  const discoveryStartTime = Date.now();

  // Two URL formats to try — the /search/ path and the ?q= query param format
  const urlFormats = [
    `https://www.google.com/maps/search/${searchQuery}`,
    `https://www.google.com/maps/search/?q=${searchQuery}&hl=en`,
  ];

  logger.info(`Discovery: starting — keyword="${keyword}" location="${location}"`);

  // ── Phase 1: Try Serper API first (if enabled) ──────────────────────────────
  const SERPER_ENABLED = process.env.SERPER_ENABLED === 'true';
  const SERPER_RESULTS_PER_QUERY = parseInt(process.env.SERPER_RESULTS_PER_QUERY || '20', 10);
  const MIN_SERPER_RESULTS = Math.min(5, SERPER_RESULTS_PER_QUERY / 4);

  if (SERPER_ENABLED) {
    try {
      logger.info(`Discovery: trying Serper API for "${keyword} ${location}"`);
      const serperStartTime = Date.now();
      
      // Format query as "keyword city country" for Serper
      const serperQuery = `${keyword} ${location}`;
      const serperResults = await searchSerper(serperQuery);
      
      const serperDuration = Date.now() - serperStartTime;
      logger.info(`Discovery: Serper request took ${serperDuration}ms`);
      
      if (validateSerperResults(serperResults, MIN_SERPER_RESULTS)) {
        const serperLeads = convertToRawLeads(serperResults);
        store.incrementMetric('serper_results_used');
        
        const totalDuration = Date.now() - discoveryStartTime;
        logger.info(`Discovery: Serper successful — ${serperLeads.length} leads found in ${totalDuration}ms`);
        return serperLeads;
      } else {
        // Serper failed or insufficient results
        store.incrementMetric('serper_fallbacks');
        logger.info(`Discovery: Serper failed or insufficient results after ${serperDuration}ms — falling back to Maps`);
      }
    } catch (error) {
      // Serper request failed
      store.incrementMetric('serper_fallbacks');
      logger.warn(`Discovery: Serper error — ${error instanceof Error ? error.message : 'unknown error'}`);
      logger.info('Discovery: falling back to Maps due to Serper error');
    }
  } else {
    logger.info('Discovery: Serper disabled via SERPER_ENABLED=false');
  }

  // ── Phase 2: Fall back to Google Maps Playwright scraper ───────────────────

  const { browser, context } = await createStealthBrowser();
  activeBrowser = browser;
  activeContext = context;

  const page = await activeContext.newPage();

  try {
    let feedSelector: string | null = null;

    // ── Try each URL format until a feed is found ─────────────────────────────
    for (let urlIdx = 0; urlIdx < urlFormats.length; urlIdx++) {
      const mapsUrl = urlFormats[urlIdx];
      logger.info(`Discovery: navigating to ${mapsUrl}`);

      await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1_500);

      await dismissConsentDialog(page);

      if (await isCaptchaPage(page)) {
        store.incrementMetric('captcha_blocked');
        emitError(jobId, { message: 'CAPTCHA detected on Google Maps. Try again later or use a different IP.' });
        logger.warn('Discovery: CAPTCHA detected on initial load — aborting');
        return rawLeads;
      }

      // Try all known feed selectors in parallel
      logger.info(`Discovery: waiting for results feed (attempt ${urlIdx + 1}/${urlFormats.length})...`);
      feedSelector = await waitForFeed(page, FEED_TIMEOUT_MS);

      if (feedSelector) {
        logger.info(`Discovery: feed found with selector "${feedSelector}"`);
        break;
      }

      // Log diagnostic info before retrying
      const currentUrl = page.url();
      const title = await page.title().catch(() => 'unknown');
      logger.warn(`Discovery: no feed found on attempt ${urlIdx + 1} — URL="${currentUrl}" title="${title}"`);

      if (urlIdx < urlFormats.length - 1) {
        logger.info('Discovery: retrying with alternate URL format...');
        await page.waitForTimeout(2_000);
      }
    }

    // ── All URL formats exhausted — give up ───────────────────────────────────
    if (!feedSelector) {
      const currentUrl = page.url();
      const title = await page.title().catch(() => 'unknown');
      logger.warn(`Discovery: results feed not found after all attempts — URL="${currentUrl}" title="${title}"`);
      emitError(jobId, {
        message: 'Google Maps results feed not found. This may be a temporary block or a DOM change. Try again in a few minutes.',
      });
      return rawLeads;
    }

    // ── Scroll to load results ────────────────────────────────────────────────
    logger.info('Discovery: scrolling results feed...');
    let prevCount = 0;
    let noNewResultsStreak = 0;

    // Phase 3.4: Dynamic scroll waiting (feature-flagged via DYNAMIC_WAITS_ENABLED)
    // When enabled: waits for DOM stabilization instead of a fixed pause.
    // When disabled (default): uses fixed SCROLL_PAUSE_MS for safety.
    // Requirement: only enable after Serper fallback stability validation.
    const DYNAMIC_WAITS_ENABLED = process.env.DYNAMIC_WAITS_ENABLED === 'true';

    while (!stopSignal.stopped) {
      await scrollFeed(page, feedSelector);

      if (DYNAMIC_WAITS_ENABLED) {
        // Dynamic wait: poll feed item count until stable (max 3s)
        const stableCount = await waitForFeedStable(page, feedSelector, prevCount, 3_000);
        if (stableCount === prevCount) {
          noNewResultsStreak++;
        } else {
          noNewResultsStreak = 0;
        }
        prevCount = stableCount;
      } else {
        // Fixed pause (safe default)
        await page.waitForTimeout(SCROLL_PAUSE_MS + Math.floor(Math.random() * 200));
        const currentCount = await countFeedItems(page, feedSelector);
        if (currentCount === prevCount) {
          noNewResultsStreak++;
        } else {
          noNewResultsStreak = 0;
        }
        prevCount = currentCount;
      }

      if (noNewResultsStreak >= 3) {
        logger.info(`Discovery: no new results after ${noNewResultsStreak} scrolls — stopping scroll`);
        break;
      }
      if (prevCount >= MAPS_RESULTS_CAP) {
        logger.info(`Discovery: reached Maps results cap (${MAPS_RESULTS_CAP}) — stopping scroll`);
        break;
      }
    }

    // ── Extract inline from list ──────────────────────────────────────────────
    logger.info('Discovery: extracting data from list...');
    const inlineResults = await extractFromList(page, feedSelector);
    logger.info(`Discovery: extracted ${inlineResults.length} results from list`);

    if (inlineResults.length === 0) {
      // Log a sample of the feed HTML for debugging
      const feedSample = await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (!feed) return 'feed element not found';
        const children = Array.from(feed.children).slice(0, 2);
        return children.map((c) => c.className + ' | ' + c.innerHTML.slice(0, 120)).join('\n');
      }, feedSelector).catch(() => 'could not read feed');
      logger.warn(`Discovery: 0 inline results. Feed sample:\n${feedSample}`);
      emitError(jobId, { message: 'No business listings found on Google Maps for this search.' });
      return rawLeads;
    }

    // ── Process results ───────────────────────────────────────────────────────
    const toProcess = inlineResults.slice(0, MAPS_RESULTS_CAP);
    let fallbackCount = 0;

    for (let i = 0; i < toProcess.length && rawLeads.length < MAX_LEADS; i++) {
      if (stopSignal.stopped) {
        logger.info('Discovery: stop signal received — halting extraction');
        break;
      }

      if (await isCaptchaPage(page)) {
        store.incrementMetric('captcha_blocked');
        emitError(jobId, { message: `CAPTCHA detected after ${rawLeads.length} leads. Discovery stopped.` });
        logger.warn(`Discovery: CAPTCHA detected at result ${i} — stopping`);
        break;
      }

      const inline = toProcess[i];
      let { rawPhone, website } = inline;

      // Fallback: navigate to detail panel only if both phone AND website are missing
      if (!rawPhone && !website && inline.placeUrl) {
        fallbackCount++;
        logger.info(`Discovery: fallback navigation for "${inline.name}" (${fallbackCount} fallbacks so far)`);

        const detail = await extractFromDetailPanel(page, inline.placeUrl);
        if (detail) {
          rawPhone = detail.rawPhone || rawPhone;
          website = detail.website || website;
        }

        await randomDelay();
      }

      const lead: RawLead = {
        name: inline.name,
        address: inline.address,
        rawPhone,
        website: normaliseUrl(website),
        placeId: `maps-inline-${i}`,
      };

      rawLeads.push(lead);
      logger.info(
        `Discovery [${rawLeads.length}/${toProcess.length}]: "${lead.name}" | phone="${lead.rawPhone}" | web="${lead.website}"`
      );

      if (rawLeads.length % 10 === 0) {
        const stats = store.getStats();
        emitStatus(jobId, { status: 'running', leadCount: stats.leadCount, discardCount: stats.discardCount });
      }
    }

    const mapsDuration = Date.now() - discoveryStartTime;
    logger.info(
      `Discovery: complete — ${rawLeads.length} raw leads (${fallbackCount} required fallback navigation) in ${mapsDuration}ms`
    );
    return rawLeads;
  } finally {
    await page.close().catch(() => {});
  }
}

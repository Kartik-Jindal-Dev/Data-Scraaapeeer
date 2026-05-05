/**
 * pipeline/discovery.ts
 * Business discovery via Playwright on Google Maps.
 *
 * FREE STACK: No Outscraper API. No paid services.
 * Primary source: https://www.google.com/maps/search/<keyword>+<location>
 *
 * Strategy (Tier 2.1 — inline list extraction):
 * 1. Navigate to Google Maps search URL.
 * 2. Wait for the results feed ([role="feed"]).
 * 3. Scroll the feed to load up to MAX_LEADS results.
 * 4. Extract name, address, phone, website DIRECTLY from the list items —
 *    no per-place navigation needed for most results.
 * 5. For results missing both phone AND website, click through to the detail
 *    panel as a fallback (typically ~20–30% of results).
 * 6. Apply delay only between fallback detail-panel navigations.
 * 7. Detect CAPTCHA — if found, increment metric, emit SSE error, stop safely.
 *
 * This approach eliminates ~70–80% of per-place page navigations compared to
 * the previous strategy, cutting discovery time by 60–80%.
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

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LEADS = parseInt(process.env.MAX_LEADS_PER_RUN ?? '100', 10);
const BASE_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS ?? '500', 10);
const JITTER_MS = parseInt(process.env.REQUEST_DELAY_JITTER_MS ?? '200', 10);
const FEED_TIMEOUT_MS = 20_000;
const SCROLL_PAUSE_MS = 1_200;

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
  return url.replace(/\/$/, '');
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

// ─── Inline List Extraction (Tier 2.1) ───────────────────────────────────────

interface InlineResult {
  name: string;
  address: string;
  rawPhone: string;
  website: string;
  placeUrl: string; // canonical /maps/place/ URL for fallback navigation
}

/**
 * Extracts all available data directly from the Maps search results list.
 * No page navigation required — reads the already-rendered DOM.
 *
 * Returns one entry per result card. Fields may be empty if not shown inline
 * (phone and website are sometimes absent from the list view).
 */
async function extractFromList(page: Page): Promise<InlineResult[]> {
  return page.$$eval('[role="feed"] > div', (cards) => {
    const results: Array<{
      name: string;
      address: string;
      rawPhone: string;
      website: string;
      placeUrl: string;
    }> = [];

    for (const card of cards) {
      // ── Name ──────────────────────────────────────────────────────────────
      const name =
        card.querySelector('.fontHeadlineSmall')?.textContent?.trim() ||
        card.querySelector('[class*="fontHeadline"]')?.textContent?.trim() ||
        card.querySelector('span[aria-label]')?.getAttribute('aria-label')?.trim() ||
        '';

      if (!name || name.toLowerCase() === 'results') continue;

      // ── Address ───────────────────────────────────────────────────────────
      // Address is typically in the second W4Efsd span group
      const addressSpans = card.querySelectorAll('.W4Efsd span');
      let address = '';
      for (const span of Array.from(addressSpans)) {
        const text = span.textContent?.trim() ?? '';
        // Address spans contain · separators; pick the one that looks like an address
        if (text && !text.startsWith('·') && text.length > 5 && /\d|road|street|sector|nagar|colony|block/i.test(text)) {
          address = text;
          break;
        }
      }
      // Fallback: just grab all W4Efsd text
      if (!address) {
        address = card.querySelector('.W4Efsd')?.textContent?.trim() ?? '';
      }

      // ── Phone ─────────────────────────────────────────────────────────────
      // Phone is sometimes shown inline as a span with a phone icon sibling
      let rawPhone = '';
      const allSpans = card.querySelectorAll('span');
      for (const span of Array.from(allSpans)) {
        const text = span.textContent?.trim() ?? '';
        // Match phone-like patterns: starts with digit/+, 7–15 chars of digits/spaces/dashes
        if (/^[+\d][\d\s\-().]{6,14}$/.test(text)) {
          rawPhone = text;
          break;
        }
      }

      // ── Website ───────────────────────────────────────────────────────────
      // Website link is an <a> with data-item-id="authority" or aria-label containing "website"
      const websiteAnchor =
        (card.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null) ||
        (card.querySelector('a[aria-label*="website" i]') as HTMLAnchorElement | null) ||
        (card.querySelector('a[aria-label*="Website"]') as HTMLAnchorElement | null);
      const website = websiteAnchor?.href ?? '';

      // ── Place URL (for fallback navigation) ───────────────────────────────
      const placeAnchor = card.querySelector('a[href*="/maps/place/"]') as HTMLAnchorElement | null;
      const placeUrl = placeAnchor?.href ?? '';

      results.push({ name, address, rawPhone, website, placeUrl });
    }

    return results;
  }).catch(() => []);
}

// ─── Detail Panel Extraction (fallback for missing phone/website) ─────────────

/**
 * Navigates to a place URL and extracts the full detail panel.
 * Only called for results where inline extraction yielded no phone AND no website.
 */
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
  const mapsUrl = `https://www.google.com/maps/search/${searchQuery}`;

  logger.info(`Discovery: starting — keyword="${keyword}" location="${location}"`);
  logger.info(`Discovery: URL = ${mapsUrl}`);

  const { browser, context } = await createStealthBrowser();
  activeBrowser = browser;
  activeContext = context;

  const page = await activeContext.newPage();

  try {
    await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_500);

    await dismissConsentDialog(page);

    if (await isCaptchaPage(page)) {
      store.incrementMetric('captcha_blocked');
      emitError(jobId, { message: 'CAPTCHA detected on Google Maps. Try again later or use a different IP.' });
      logger.warn('Discovery: CAPTCHA detected on initial load — aborting');
      return rawLeads;
    }

    // ── Wait for results feed ─────────────────────────────────────────────────
    try {
      await page.waitForSelector('[role="feed"]', { timeout: FEED_TIMEOUT_MS });
    } catch {
      const currentUrl = page.url();
      const title = await page.title().catch(() => 'unknown');
      logger.warn(`Discovery: results feed not found — URL="${currentUrl}" title="${title}"`);
      emitError(jobId, { message: 'Google Maps results feed not found. The page structure may have changed.' });
      return rawLeads;
    }

    // ── Scroll to load results ────────────────────────────────────────────────
    logger.info('Discovery: scrolling results feed...');
    let prevCount = 0;
    let noNewResultsStreak = 0;

    while (!stopSignal.stopped) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollBy(0, 1000);
      });
      await page.waitForTimeout(SCROLL_PAUSE_MS + Math.floor(Math.random() * 200));

      const currentCount = await page
        .$$eval('[role="feed"] > div', (els) => els.length)
        .catch(() => 0);

      if (currentCount === prevCount) {
        noNewResultsStreak++;
        if (noNewResultsStreak >= 3) {
          logger.info(`Discovery: no new results after ${noNewResultsStreak} scrolls — stopping scroll`);
          break;
        }
      } else {
        noNewResultsStreak = 0;
      }
      prevCount = currentCount;
      if (currentCount >= MAX_LEADS) break;
    }

    // ── Step 1: Extract inline from list (Tier 2.1 — no navigation needed) ───
    logger.info('Discovery: extracting data from list...');
    const inlineResults = await extractFromList(page);
    logger.info(`Discovery: extracted ${inlineResults.length} results from list`);

    if (inlineResults.length === 0) {
      const feedInfo = await page.$$eval('[role="feed"] > div', (divs) =>
        divs.slice(0, 2).map((d) => d.className + ' | ' + d.innerHTML.slice(0, 120))
      ).catch(() => ['could not read feed']);
      logger.warn(`Discovery: 0 inline results. Feed sample: ${JSON.stringify(feedInfo)}`);
      emitError(jobId, { message: 'No business listings found on Google Maps for this search.' });
      return rawLeads;
    }

    // ── Step 2: Process results — use inline data, fallback for missing fields ─
    const toProcess = inlineResults.slice(0, MAX_LEADS);
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

      // ── Fallback: navigate to detail panel only if both phone AND website missing
      if (!rawPhone && !website && inline.placeUrl) {
        fallbackCount++;
        logger.info(`Discovery: fallback navigation for "${inline.name}" (${fallbackCount} fallbacks so far)`);

        const detail = await extractFromDetailPanel(page, inline.placeUrl);
        if (detail) {
          rawPhone = detail.rawPhone || rawPhone;
          website = detail.website || website;
        }

        // Small delay only after fallback navigations
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

    logger.info(
      `Discovery: complete — ${rawLeads.length} raw leads (${fallbackCount} required fallback navigation)`
    );
    return rawLeads;
  } finally {
    await page.close().catch(() => {});
  }
}

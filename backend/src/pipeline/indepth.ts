/**
 * pipeline/indepth.ts
 * In-depth crawl — scrapes homepage + up to MAX_SUBPAGES sub-pages per lead.
 *
 * Activated when depth === 'indepth'.
 * For depth === 'homepage', the pipeline uses scrapePage() directly and skips this module.
 *
 * Strategy:
 * 1. Scrape the homepage (via scrapePage — reuses Phase 3 static/dynamic detection).
 * 2. Extract sub-page URLs from homepage HTML using extractContactSubPageUrls().
 * 3. Scrape up to MAX_SUBPAGES sub-pages (same-domain only, no recursion).
 * 4. Combine all HTML strings into a single merged string for extraction.
 * 5. Deduplicate emails and phones across all pages before returning.
 *
 * CONSTRAINTS:
 * - Same-domain links only (enforced by extractContactSubPageUrls).
 * - Max 3 sub-pages per lead (MAX_SUBPAGES = 3).
 * - Total per-lead timeout: 30 seconds (LEAD_TOTAL_TIMEOUT_MS).
 * - Stop signal checked before each sub-page fetch.
 * - No email/phone extraction here — returns merged HTML only.
 * - website_unreachable metric incremented by scrapePage() on failure (not here).
 * - subpages_scraped metric incremented for each successfully fetched sub-page.
 */

import { logger } from '../logger';
import { store } from '../store';
import { scrapePage, extractContactSubPageUrls, ScrapeResult } from './scraper';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum sub-pages to scrape per lead in in-depth mode. */
const MAX_SUBPAGES = parseInt(process.env.INDEPTH_MAX_SUBPAGES ?? '5', 10);

/** Hard timeout for the entire per-lead in-depth scrape (homepage + sub-pages). */
const LEAD_TOTAL_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InDepthResult {
  /**
   * Merged HTML from homepage + all successfully scraped sub-pages.
   * Empty string if the homepage itself was unreachable.
   */
  mergedHtml: string;

  /** Final URL of the homepage after redirects. */
  finalUrl: string;

  /** True if the homepage was unreachable. Sub-page failures do not set this. */
  unreachable: boolean;

  /** Number of sub-pages successfully scraped (0 for homepage-only or all-failed). */
  subpagesScraped: number;
}

// ─── Main In-Depth Scrape Function ───────────────────────────────────────────

/**
 * Scrapes a business website in-depth: homepage + up to MAX_SUBPAGES (default 5) sub-pages.
 *
 * @param websiteUrl  - The business's homepage URL
 * @param stopSignal  - Checked before each sub-page fetch; aborts if stopped
 * @param businessName - Used for logging only
 * @returns InDepthResult with merged HTML and metadata
 *
 * Never throws. All errors are caught and logged.
 */
export async function scrapeInDepth(
  websiteUrl: string,
  stopSignal: { stopped: boolean },
  businessName: string
): Promise<InDepthResult> {
  if (!websiteUrl || websiteUrl.trim().length === 0) {
    return { mergedHtml: '', finalUrl: '', unreachable: true, subpagesScraped: 0 };
  }

  // ── Wrap entire operation in a 30s hard timeout ───────────────────────────
  const timeoutPromise = new Promise<InDepthResult>((resolve) =>
    setTimeout(() => {
      logger.warn(`InDepth: 30s timeout reached for "${businessName}" — returning partial results`);
      resolve({ mergedHtml: '', finalUrl: websiteUrl, unreachable: false, subpagesScraped: 0 });
    }, LEAD_TOTAL_TIMEOUT_MS)
  );

  const crawlWork = async (): Promise<InDepthResult> => {
    const htmlParts: string[] = [];
    let subpagesScraped = 0;

    // ── Step 1: Scrape homepage ─────────────────────────────────────────────
    logger.info(`InDepth: scraping homepage for "${businessName}" — ${websiteUrl}`);
    const homepageResult: ScrapeResult = await scrapePage(websiteUrl);

    if (homepageResult.unreachable) {
      // website_unreachable metric already incremented by scrapePage()
      logger.info(`InDepth: homepage unreachable for "${businessName}"`);
      return { mergedHtml: '', finalUrl: websiteUrl, unreachable: true, subpagesScraped: 0 };
    }

    htmlParts.push(homepageResult.html);
    const finalUrl = homepageResult.finalUrl || websiteUrl;

    // ── Step 2: Extract sub-page URLs from homepage HTML ────────────────────
    const subPageUrls = extractContactSubPageUrls(
      homepageResult.html,
      finalUrl
    ).slice(0, MAX_SUBPAGES);

    logger.info(
      `InDepth: found ${subPageUrls.length} sub-page(s) for "${businessName}": ${subPageUrls.join(', ')}`
    );

    // ── Step 3: Scrape each sub-page ────────────────────────────────────────
    const visitedUrls = new Set<string>([finalUrl.replace(/\/$/, '')]);

    for (const subUrl of subPageUrls) {
      if (stopSignal.stopped) {
        logger.info(`InDepth: stop signal — aborting sub-page scrape for "${businessName}"`);
        break;
      }

      // Avoid re-scraping the same URL (normalise trailing slash)
      const normUrl = subUrl.replace(/\/$/, '');
      if (visitedUrls.has(normUrl)) {
        logger.info(`InDepth: skipping duplicate sub-page ${subUrl}`);
        continue;
      }
      visitedUrls.add(normUrl);

      logger.info(`InDepth: scraping sub-page ${subUrl} for "${businessName}"`);
      const subResult: ScrapeResult = await scrapePage(subUrl);

      if (!subResult.unreachable && subResult.html) {
        htmlParts.push(subResult.html);
        subpagesScraped++;
        store.incrementMetric('subpages_scraped');
        logger.info(
          `InDepth: sub-page scraped — ${subUrl} (${subResult.html.length} bytes)`
        );
      } else {
        logger.info(`InDepth: sub-page unreachable — ${subUrl}`);
        // website_unreachable already incremented by scrapePage() — do not double-count
      }
    }

    // ── Step 4: Merge all HTML ──────────────────────────────────────────────
    // Concatenate with a separator so regex patterns don't bleed across page boundaries
    const mergedHtml = htmlParts.join('\n<!-- PAGE_BREAK -->\n');

    logger.info(
      `InDepth: complete for "${businessName}" — ` +
      `homepage + ${subpagesScraped} sub-page(s), ${mergedHtml.length} bytes total`
    );

    return { mergedHtml, finalUrl, unreachable: false, subpagesScraped };
  };

  return Promise.race([crawlWork(), timeoutPromise]);
}

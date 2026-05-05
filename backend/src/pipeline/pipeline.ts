/**
 * pipeline/pipeline.ts
 * Main job pipeline orchestrator.
 *
 * Full execution order:
 * 1. Geocode validation (Nominatim)
 * 2. Discovery (Playwright on Google Maps — inline list extraction)
 * 3. Deduplication (normalizedPhone|rootDomain via tldts)
 * 4. Website scraping — concurrent batches (SCRAPE_CONCURRENCY, default 10)
 *    - depth=homepage: scrapePage() (homepage only)
 *    - depth=indepth:  scrapeInDepth() (homepage + up to 3 sub-pages, 30s timeout)
 * 5. Email extraction (mailto + regex + blacklist + rank)
 * 6. Phone normalisation (libphonenumber-js + ISO hint)
 * 7. Filter + quality tier + store.addLead() + emitLead()
 *
 * Tier 2.2 — Streaming pipeline:
 * Steps 4–7 are pipelined: each batch of leads is scraped, extracted, filtered,
 * and emitted to the frontend immediately — no waiting for all scraping to finish.
 * This means the first leads appear in the UI within seconds of discovery completing.
 *
 * CONSTRAINTS:
 * - Filter runs ONLY after all scraping + extraction steps are complete for each lead.
 * - Stop signal is checked before each major step and between each lead.
 * - _hasBoth and _qualityTier are INTERNAL ONLY — never in SSE payloads or exports.
 * - In-depth crawl: max 3 sub-pages per lead, same-domain only, 30s total timeout.
 */

import { logger } from '../logger';
import { store } from '../store';
import { emitStatus, closeSSEConnection } from '../sse';
import { JobContext, RawLead } from '../types';
import { discoverLeads, forceCloseBrowser } from './discovery';
import { isDuplicateLead } from './deduplicator';
import { scrapePage, closeScraperBrowser } from './scraper';
import { scrapeInDepth } from './indepth';
import { extractEmail } from './emailExtractor';
import { extractPhone } from './phoneNormalizer';
import { processLead, ExtractedLead } from './filter';

// ─── Stop Signal ──────────────────────────────────────────────────────────────

export const stopSignal = { stopped: false };

export function resetStopSignal(): void {
  stopSignal.stopped = false;
}

export function signalStop(): void {
  stopSignal.stopped = true;
  logger.info('Pipeline: stop signal set');
}

// ─── Pipeline Entry Point ─────────────────────────────────────────────────────

export async function runPipeline(ctx: JobContext): Promise<void> {
  const { jobId, keyword, location, depth, isoCountryCode } = ctx;
  const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY ?? '10', 10);

  logger.info(
    `Pipeline: started — jobId=${jobId} keyword="${keyword}" location="${location}" depth=${depth} concurrency=${CONCURRENCY}`
  );

  try {
    logger.info(`Pipeline: geocode complete — ISO=${isoCountryCode}`);

    if (stopSignal.stopped) {
      await finishJob(jobId, 'stopped');
      return;
    }

    // ── Step 2: Discovery ─────────────────────────────────────────────────────
    emitStatus(jobId, {
      status: 'running',
      leadCount: store.getLeadCount(),
      discardCount: store.getStats().discardCount,
    });

    const rawLeads: RawLead[] = await discoverLeads(jobId, keyword, location, stopSignal);
    logger.info(`Pipeline: discovery returned ${rawLeads.length} raw leads`);

    if (stopSignal.stopped) {
      await finishJob(jobId, 'stopped');
      return;
    }

    // ── Step 3: Deduplication ─────────────────────────────────────────────────
    const dedupedLeads: RawLead[] = [];
    for (const raw of rawLeads) {
      if (!isDuplicateLead(raw)) dedupedLeads.push(raw);
    }

    logger.info(
      `Pipeline: dedup complete — ${dedupedLeads.length} unique, ${rawLeads.length - dedupedLeads.length} skipped`
    );

    if (stopSignal.stopped) {
      await finishJob(jobId, 'stopped');
      return;
    }

    // ── Steps 4–7: Scrape → Extract → Filter → Store → SSE (streaming) ───────
    // Tier 2.2: process in concurrent batches and emit each lead immediately.
    // The frontend receives leads as soon as each batch completes — no waiting
    // for all scraping to finish before any results appear.
    logger.info(
      `Pipeline: starting scrape+extract+filter (depth=${depth}, concurrency=${CONCURRENCY}) for ${dedupedLeads.length} leads`
    );

    let totalAccepted = 0;
    let totalDiscarded = 0;

    for (let batchStart = 0; batchStart < dedupedLeads.length; batchStart += CONCURRENCY) {
      if (stopSignal.stopped) {
        logger.info('Pipeline: stop signal — aborting');
        break;
      }

      const batch = dedupedLeads.slice(batchStart, Math.min(batchStart + CONCURRENCY, dedupedLeads.length));
      const batchNum = Math.floor(batchStart / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(dedupedLeads.length / CONCURRENCY);

      logger.info(`Pipeline: batch ${batchNum}/${totalBatches} — scraping ${batch.length} leads`);

      // ── Step 4: Scrape all leads in this batch concurrently ────────────────
      const scraped = await Promise.all(
        batch.map(async (raw, idx) => {
          const globalIdx = batchStart + idx;

          if (!raw.website) {
            logger.info(`Scraper [${globalIdx + 1}/${dedupedLeads.length}]: "${raw.name}" — no website`);
            return { raw, html: '', finalUrl: '' };
          }

          if (depth === 'indepth') {
            const result = await scrapeInDepth(raw.website, stopSignal, raw.name);
            logger.info(
              `InDepth [${globalIdx + 1}/${dedupedLeads.length}]: "${raw.name}" — ` +
              `${result.unreachable ? 'unreachable' : `${result.mergedHtml.length} bytes, ${result.subpagesScraped} sub-page(s)`}`
            );
            return {
              raw,
              html: result.unreachable ? '' : result.mergedHtml,
              finalUrl: result.unreachable ? raw.website : result.finalUrl,
            };
          } else {
            const result = await scrapePage(raw.website);
            logger.info(
              `Scraper [${globalIdx + 1}/${dedupedLeads.length}]: "${raw.name}" — ` +
              `${result.unreachable ? 'unreachable' : `${result.html.length} bytes`}`
            );
            return {
              raw,
              html: result.unreachable ? '' : result.html,
              finalUrl: result.unreachable ? raw.website : result.finalUrl,
            };
          }
        })
      );

      // ── Steps 5–7: Extract → Filter → Store → SSE for this batch ──────────
      // Runs immediately after scraping completes — no waiting for other batches.
      for (const { raw, html, finalUrl } of scraped) {
        if (stopSignal.stopped) break;

        const email = await extractEmail(html, raw.website || finalUrl);
        const phone = extractPhone(raw.rawPhone, html, isoCountryCode, raw.name);

        const extractedLead: ExtractedLead = { raw, email, phone, html };
        const passed = processLead(jobId, extractedLead);

        if (passed) totalAccepted++;
        else totalDiscarded++;
      }

      // Emit progress after each batch
      const stats = store.getStats();
      emitStatus(jobId, {
        status: 'running',
        leadCount: stats.leadCount,
        discardCount: stats.discardCount,
      });

      logger.info(
        `Pipeline: batch ${batchNum}/${totalBatches} complete — running totals: ${totalAccepted} accepted, ${totalDiscarded} discarded`
      );
    }

    logger.info(
      `Pipeline: all batches complete — ${totalAccepted} accepted, ${totalDiscarded} discarded`
    );

    await finishJob(jobId, stopSignal.stopped ? 'stopped' : 'completed');
  } catch (err) {
    logger.error(`Pipeline: unhandled error — ${(err as Error).message}`);
    await finishJob(jobId, 'error');
  } finally {
    await forceCloseBrowser();
    await closeScraperBrowser();
  }
}

// ─── Job Finish Helper ────────────────────────────────────────────────────────

async function finishJob(
  jobId: string,
  status: 'completed' | 'stopped' | 'error'
): Promise<void> {
  store.setStatus(status);
  const stats = store.getStats();

  logger.info(
    `Pipeline: finished — status=${status} leads=${stats.leadCount} discarded=${stats.discardCount}`
  );

  emitStatus(jobId, {
    status,
    leadCount: stats.leadCount,
    discardCount: stats.discardCount,
  });

  closeSSEConnection(jobId);
}

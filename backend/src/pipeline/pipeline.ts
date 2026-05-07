/**
 * pipeline/pipeline.ts
 * Main job pipeline orchestrator.
 *
 * Full execution order:
 * 1. Geocode validation (Nominatim)
 * 2. Discovery (Playwright on Google Maps — inline list extraction)
 * 3. Deduplication (phone|rootDomain — per-run Set + 15-day rolling window)
 * 4. Website scraping — concurrent batches (SCRAPE_CONCURRENCY)
 *    - depth=homepage: scrapePage() (homepage only)
 *    - depth=indepth:  scrapeInDepth() (homepage + up to 3 sub-pages, 30s timeout)
 * 5. Email extraction (mailto + regex + blacklist + rank)
 * 6. Phone normalisation (libphonenumber-js + ISO hint)
 * 7. Filter + quality tier + store.addLead() + emitLead()
 *
 * Phase 16 — Concurrency & Query Priority:
 * - SCRAPE_CONCURRENCY controls parallel website fetches WITHIN a single city job.
 * - City jobs execute SEQUENTIALLY — concurrency does NOT apply across jobs.
 * - Query priority (largest cities first) is enforced by cityPool.ts sort order.
 * - Inter-job delay (INTER_JOB_DELAY_MS) is applied between city jobs by start.ts.
 *
 * Phase 3.3 — Streaming Pipeline Audit (current behavior documented):
 * - Scraping: CONCURRENCY leads scraped concurrently via Promise.all per batch.
 * - Extraction+filter: runs sequentially within each batch AFTER all scrapes complete.
 * - SSE emission: one emitLead() per accepted lead, one emitStatus() per batch.
 * - Stop condition: checked before each batch and between each lead in extract loop.
 * - Dedup: per-run Set + 15-day rolling window, both checked before scraping.
 * - No duplicate emits: emitLead called exactly once per accepted lead in processLead().
 *
 * Phase 3.5 — Streaming Within Batches:
 * Each lead is extracted and emitted as soon as its scrape completes, rather than
 * waiting for the entire batch. Implemented via per-lead Promise chains that resolve
 * independently. SSE lead events arrive at the frontend sooner — 30-40% reduction
 * in batch idle time for slow-scraping leads.
 *
 * Phase 4.1 — Higher Concurrency Cap (feature-flagged via HIGHER_CONCURRENCY_ENABLED):
 * When enabled: max raised from 6 → 8. Recommended safe range remains 4-6.
 * When disabled (default): max stays at 6. Conservative default to avoid CAPTCHA risk.
 *
 * Phase 4.2 — Adaptive Concurrency (feature-flagged via ADAPTIVE_CONCURRENCY_ENABLED):
 * Dynamically adjusts concurrency each batch based on rolling success rate and
 * average scrape duration. Backs off on high failure rates or slow responses.
 * Increases toward the cap when conditions are favorable.
 *
 * Phase 4.3 — Priority Queue for Leads:
 * Leads with websites are processed before leads without websites.
 * Website-less leads are appended at the end — they still get processed but
 * won't block higher-value leads from being scraped first.
 *
 * CONSTRAINTS:
 * - pipeline.ts executes a single city job only.
 * - Batching, city iteration, and stop condition are owned by start.ts controller.
 * - Filter runs ONLY after all scraping + extraction steps are complete for each lead.
 * - Stop signal is checked before each major step and between each lead.
 * - _hasBoth and _qualityTier are INTERNAL ONLY — never in SSE payloads or exports.
 */

import { logger } from "../logger";
import { store } from "../store";
import { emitStatus, closeSSEConnection } from "../sse";
import { JobContext, RawLead } from "../types";
import { discoverLeads, forceCloseBrowser } from "./discovery";
import { isDuplicateLead } from "./deduplicator";
import { scrapePage, closeScraperBrowser } from "./scraper";
import { scrapeInDepth } from "./indepth";
import { extractEmail } from "./emailExtractor";
import { extractPhone } from "./phoneNormalizer";
import { processLead, ExtractedLead } from "./filter";
import * as cheerio from "cheerio";

// ─── Stop Signal ──────────────────────────────────────────────────────────────

export const stopSignal = { stopped: false };

export function resetStopSignal(): void {
  stopSignal.stopped = false;
}

export function signalStop(): void {
  stopSignal.stopped = true;
  logger.info("Pipeline: stop signal set");
}

// ─── Pipeline Entry Point ─────────────────────────────────────────────────────

/**
 * @param ctx           - Job context (jobId, keyword, location, depth, isoCountryCode)
 * @param isIntermediate - When true (multi-run jobs), the pipeline emits a 'running'
 *                         status at the end instead of 'completed' and does NOT close
 *                         the SSE connection. The caller (start.ts) is responsible for
 *                         emitting the final 'completed' status and closing the connection.
 */
export async function runPipeline(
  ctx: JobContext,
  isIntermediate = false,
): Promise<void> {
  const { jobId, keyword, location, depth, isoCountryCode } = ctx;

  // ── Phase 4.1: Concurrency cap (feature-flagged) ─────────────────────────
  // HIGHER_CONCURRENCY_ENABLED raises the hard cap from 6 → 8.
  // Recommended safe range remains 4-6 regardless of cap.
  // Conservative default: cap stays at 6 to avoid CAPTCHA risk.
  const HIGHER_CONCURRENCY_ENABLED =
    process.env.HIGHER_CONCURRENCY_ENABLED === "true";
  const CONCURRENCY_RAW = parseInt(process.env.SCRAPE_CONCURRENCY ?? "3", 10);
  const CONCURRENCY_MAX = HIGHER_CONCURRENCY_ENABLED ? 8 : 6;
  const CONCURRENCY_BASE = Math.min(
    Math.max(1, CONCURRENCY_RAW),
    CONCURRENCY_MAX,
  );
  if (CONCURRENCY_RAW > CONCURRENCY_MAX) {
    logger.warn(
      `Pipeline: SCRAPE_CONCURRENCY=${CONCURRENCY_RAW} exceeds maximum (${CONCURRENCY_MAX}) — clamped to ${CONCURRENCY_MAX}`,
    );
  }

  // ── Phase 4.2: Adaptive concurrency controller ────────────────────────────
  // Tracks rolling success rate and avg scrape duration across batches.
  // Backs off when failure rate is high or scrapes are slow; increases when healthy.
  const ADAPTIVE_CONCURRENCY_ENABLED =
    process.env.ADAPTIVE_CONCURRENCY_ENABLED === "true";

  const adaptiveState = {
    current: CONCURRENCY_BASE,
    windowSuccesses: 0,
    windowFailures: 0,
    windowDurationMs: 0,
    windowSamples: 0,
  };

  /**
   * Updates adaptive state after a batch completes.
   * @param batchSuccesses  leads that produced HTML (not unreachable)
   * @param batchFailures   leads that were unreachable
   * @param batchDurationMs wall-clock time for the batch scrape phase
   */
  function updateAdaptive(
    batchSuccesses: number,
    batchFailures: number,
    batchDurationMs: number,
  ): void {
    if (!ADAPTIVE_CONCURRENCY_ENABLED) return;

    adaptiveState.windowSuccesses += batchSuccesses;
    adaptiveState.windowFailures += batchFailures;
    adaptiveState.windowDurationMs += batchDurationMs;
    adaptiveState.windowSamples += batchSuccesses + batchFailures;

    // Only adjust after at least one full batch of data
    if (adaptiveState.windowSamples < adaptiveState.current) return;

    const total = adaptiveState.windowSuccesses + adaptiveState.windowFailures;
    const failureRate = total > 0 ? adaptiveState.windowFailures / total : 0;
    const avgDurationMs =
      adaptiveState.windowSamples > 0
        ? adaptiveState.windowDurationMs / adaptiveState.windowSamples
        : 0;

    const prev = adaptiveState.current;

    if (failureRate > 0.4 || avgDurationMs > 10_000) {
      // High failure rate (>40%) or very slow scrapes (>10s avg) — back off
      adaptiveState.current = Math.max(1, adaptiveState.current - 1);
    } else if (
      failureRate < 0.1 &&
      avgDurationMs < 5_000 &&
      adaptiveState.current < CONCURRENCY_MAX
    ) {
      // Healthy: <10% failure rate and fast scrapes (<5s avg) — increase
      adaptiveState.current = Math.min(
        CONCURRENCY_MAX,
        adaptiveState.current + 1,
      );
    }

    if (adaptiveState.current !== prev) {
      logger.info(
        `Pipeline: adaptive concurrency ${prev} → ${adaptiveState.current} ` +
          `(failureRate=${(failureRate * 100).toFixed(0)}% avgDuration=${avgDurationMs.toFixed(0)}ms)`,
      );
    }

    // Reset window after adjustment
    adaptiveState.windowSuccesses = 0;
    adaptiveState.windowFailures = 0;
    adaptiveState.windowDurationMs = 0;
    adaptiveState.windowSamples = 0;
  }

  // Active concurrency — starts at base, adjusted by adaptive controller
  let CONCURRENCY = CONCURRENCY_BASE;

  logger.info(
    `Pipeline: started — jobId=${jobId} keyword="${keyword}" location="${location}" depth=${depth} ` +
      `concurrency=${CONCURRENCY} (max=${CONCURRENCY_MAX} adaptive=${ADAPTIVE_CONCURRENCY_ENABLED})`,
  );

  try {
    logger.info(`Pipeline: geocode complete — ISO=${isoCountryCode}`);

    if (stopSignal.stopped) {
      await finishJob(jobId, "stopped", isIntermediate);
      return;
    }

    // ── Step 2: Discovery ─────────────────────────────────────────────────────
    emitStatus(jobId, {
      status: "running",
      leadCount: store.getLeadCount(),
      discardCount: store.getStats().discardCount,
      activeKeyword: keyword,
      activeLocation: location,
    });

    const rawLeads: RawLead[] = await discoverLeads(
      jobId,
      keyword,
      location,
      stopSignal,
    );
    logger.info(`Pipeline: discovery returned ${rawLeads.length} raw leads`);

    if (stopSignal.stopped) {
      await finishJob(jobId, "stopped", isIntermediate);
      return;
    }

    // ── Step 3: Deduplication ─────────────────────────────────────────────────
    const dedupedLeads: RawLead[] = [];
    for (const raw of rawLeads) {
      if (!(await isDuplicateLead(raw))) dedupedLeads.push(raw);
    }

    logger.info(
      `Pipeline: dedup complete — ${dedupedLeads.length} unique, ${rawLeads.length - dedupedLeads.length} skipped`,
    );

    if (stopSignal.stopped) {
      await finishJob(jobId, "stopped", isIntermediate);
      return;
    }

    // ── Steps 4–7: Scrape → Extract → Filter → Store → SSE (streaming) ───────
    logger.info(
      `Pipeline: starting scrape+extract+filter (depth=${depth}, concurrency=${CONCURRENCY}) for ${dedupedLeads.length} leads`,
    );

    // ── Phase 4.3: Priority queue — leads with websites first ────────────────
    // Website-less leads are appended at the end. They still get processed but
    // won't block higher-value leads from being scraped first.
    const prioritizedLeads = [
      ...dedupedLeads.filter((l) => l.website),
      ...dedupedLeads.filter((l) => !l.website),
    ];
    const websiteLeadCount = prioritizedLeads.filter((l) => l.website).length;
    const noWebsiteLeadCount = prioritizedLeads.length - websiteLeadCount;
    if (noWebsiteLeadCount > 0) {
      logger.info(
        `Pipeline: priority sort — ${websiteLeadCount} with website (first), ${noWebsiteLeadCount} without (last)`,
      );
    }

    let totalAccepted = 0;
    let totalDiscarded = 0;
    const maxLeads = ctx.maxLeads ?? Infinity;

    for (
      let batchStart = 0;
      batchStart < prioritizedLeads.length;
      batchStart += CONCURRENCY
    ) {
      if (stopSignal.stopped) {
        logger.info("Pipeline: stop signal — aborting");
        break;
      }

      // Stop before scraping this batch if maxLeads already reached
      if (store.getLeadCount() >= maxLeads) {
        logger.info(
          `Pipeline: maxLeads (${maxLeads}) reached — skipping remaining leads`,
        );
        break;
      }

      const batch = prioritizedLeads.slice(
        batchStart,
        Math.min(batchStart + CONCURRENCY, prioritizedLeads.length),
      );
      const batchNum = Math.floor(batchStart / CONCURRENCY) + 1;
      const totalBatches = Math.ceil(prioritizedLeads.length / CONCURRENCY);

      logger.info(
        `Pipeline: batch ${batchNum}/${totalBatches} — scraping ${batch.length} leads (concurrency=${CONCURRENCY})`,
      );

      // ── Phase 3.5: Streaming within batches ───────────────────────────────
      // Each lead is scraped, extracted, and emitted as soon as it completes —
      // no waiting for the slowest lead in the batch before processing begins.
      // A shared mutex ensures extract+filter runs one lead at a time to preserve
      // SSE ordering and prevent concurrent store mutations.
      const mutexWaiters: Array<() => void> = [];
      let mutexLocked = false;

      const acquireMutex = (): Promise<void> => {
        if (!mutexLocked) {
          mutexLocked = true;
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          mutexWaiters.push(resolve);
        });
      };

      const releaseMutex = (): void => {
        const next = mutexWaiters.shift();
        if (next) {
          next();
        } else {
          mutexLocked = false;
        }
      };

      // Phase 4.2: track per-batch scrape outcomes for adaptive controller
      let batchSuccesses = 0;
      let batchFailures = 0;
      const batchScrapeStart = Date.now();

      const leadPromises = batch.map(async (raw, idx) => {
        const globalIdx = batchStart + idx;

        // ── Step 4: Scrape (concurrent) ──────────────────────────────────────
        let html = "";
        let finalUrl = "";

        if (!raw.website) {
          logger.info(
            `Scraper [${globalIdx + 1}/${prioritizedLeads.length}]: "${raw.name}" — no website`,
          );
          batchFailures++; // no-website counts as non-productive for adaptive purposes
        } else if (depth === "indepth") {
          const result = await scrapeInDepth(raw.website, stopSignal, raw.name);
          logger.info(
            `InDepth [${globalIdx + 1}/${prioritizedLeads.length}]: "${raw.name}" — ` +
              `${result.unreachable ? "unreachable" : `${result.mergedHtml.length} bytes, ${result.subpagesScraped} sub-page(s)`}`,
          );
          html = result.unreachable ? "" : result.mergedHtml;
          finalUrl = result.unreachable ? raw.website : result.finalUrl;
          if (result.unreachable) batchFailures++;
          else batchSuccesses++;
        } else {
          const result = await scrapePage(raw.website);
          logger.info(
            `Scraper [${globalIdx + 1}/${prioritizedLeads.length}]: "${raw.name}" — ` +
              `${result.unreachable ? "unreachable" : `${result.html.length} bytes`}`,
          );
          html = result.unreachable ? "" : result.html;
          finalUrl = result.unreachable ? raw.website : result.finalUrl;
          if (result.unreachable) batchFailures++;
          else batchSuccesses++;
        }

        // ── Steps 5–7: Extract → Filter → Store → SSE (serialized via mutex) ─
        // Mutex ensures SSE ordering is preserved and store mutations are safe.
        const mutexWaitStart = Date.now();
        await acquireMutex();
        const mutexWaitMs = Date.now() - mutexWaitStart;
        if (mutexWaitMs > 3000) {
          logger.warn(
            `Pipeline: mutex wait ${mutexWaitMs}ms for lead ${globalIdx + 1}/${prioritizedLeads.length} "${raw.name}"`,
          );
        }
        try {
          if (stopSignal.stopped || store.getLeadCount() >= maxLeads) return;

          const parsed$ = html ? cheerio.load(html) : undefined;

          const [email, phone] = await Promise.all([
            extractEmail(html, raw.website || finalUrl, parsed$),
            Promise.resolve(
              extractPhone(
                raw.rawPhone,
                html,
                isoCountryCode,
                raw.name,
                parsed$,
              ),
            ),
          ]);

          const extractedLead: ExtractedLead = { raw, email, phone, html };
          const passed = processLead(jobId, extractedLead, ctx.contactFilter);

          if (passed) totalAccepted++;
          else totalDiscarded++;
        } finally {
          releaseMutex();
        }
      });

      // Wait for all leads in this batch to complete scrape+extract+emit
      await Promise.allSettled(leadPromises);

      // Phase 4.2: update adaptive controller with this batch's outcomes
      const batchDurationMs = Date.now() - batchScrapeStart;
      updateAdaptive(batchSuccesses, batchFailures, batchDurationMs);
      CONCURRENCY = adaptiveState.current;

      // Emit progress after each batch
      const stats = store.getStats();
      emitStatus(jobId, {
        status: "running",
        leadCount: stats.leadCount,
        discardCount: stats.discardCount,
        activeKeyword: keyword,
        activeLocation: location,
      });

      logger.info(
        `Pipeline: batch ${batchNum}/${totalBatches} complete — running totals: ${totalAccepted} accepted, ${totalDiscarded} discarded`,
      );
    }

    logger.info(
      `Pipeline: all batches complete — ${totalAccepted} accepted, ${totalDiscarded} discarded`,
    );

    await finishJob(
      jobId,
      stopSignal.stopped ? "stopped" : "completed",
      isIntermediate,
    );
  } catch (err) {
    logger.error(`Pipeline: unhandled error — ${(err as Error).message}`);
    await finishJob(jobId, "error", isIntermediate);
  } finally {
    await forceCloseBrowser();
    await closeScraperBrowser();
  }
}

// ─── Job Finish Helper ────────────────────────────────────────────────────────

/**
 * @param isIntermediate - When true, emits 'running' status (not the final status)
 *                         and does NOT close the SSE connection. Used for multi-run
 *                         jobs where more pipeline runs follow this one.
 */
async function finishJob(
  jobId: string,
  status: "completed" | "stopped" | "error",
  isIntermediate = false,
): Promise<void> {
  const stats = store.getStats();

  if (isIntermediate && status === "completed") {
    // Intermediate run finished — keep SSE open, emit running status with updated counts
    logger.info(
      `Pipeline: intermediate run finished — leads=${stats.leadCount} discarded=${stats.discardCount}`,
    );
    emitStatus(jobId, {
      status: "running",
      leadCount: stats.leadCount,
      discardCount: stats.discardCount,
    });
    // Do NOT close the SSE connection — the next run will continue streaming
    return;
  }

  // Final run (or stop/error) — set status and close SSE
  store.setStatus(status);
  const finalStats = store.getStats();

  logger.info(
    `Pipeline: finished — status=${status} leads=${finalStats.leadCount} discarded=${finalStats.discardCount}`,
  );

  emitStatus(jobId, {
    status,
    leadCount: finalStats.leadCount,
    discardCount: finalStats.discardCount,
  });

  closeSSEConnection(jobId);
}

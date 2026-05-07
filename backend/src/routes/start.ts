/**
 * routes/start.ts
 * POST /api/start
 *
 * Phase 13 — Keyword Rule (1 Keyword):
 * - Accepts exactly 1 keyword per run (profession → primary keyword).
 * - Accepts country + states[] for city-batched execution (Phase 14).
 * - Accepts maxLeads as the single stop condition.
 * - Backward compatible: plain `location` string still accepted for
 *   single-location runs (existing integrations unaffected).
 *
 * FREE STACK: Nominatim for geocoding (legacy mode only). Playwright for discovery.
 * City-batched mode uses country-state-city + GeoNames — no Nominatim needed.
 *
 * CONSTRAINTS:
 * - Exactly 1 keyword per run — no expansion, no matrix.
 * - store.reset() is called at the start of every new job.
 * - A running job must be stopped before a new one can start.
 * - pipeline.ts executes a single job only — batching/stop owned by this controller.
 *
 * Round-Robin Scheduler (Implementation Plan Phase 4):
 * - CITY_ROUND_ROBIN_ENABLED=true  → round-robin path (stateScheduler.ts):
 *     Each round fetches the next CITY_BATCH_SIZE valid cities from EACH selected
 *     state in selection order, then processes them before starting the next round.
 *     Rounds are strictly sequential. PARALLEL_CITIES_ENABLED controls concurrency
 *     inside a round only — never across rounds.
 * - CITY_ROUND_ROBIN_ENABLED=false → existing flattened-batching path (default, unchanged):
 *     All cities from all states concatenated, processed in fixed CITY_BATCH_SIZE slices.
 * - Both paths share the same city pool build, SSE schema, store, pipeline, dedup,
 *   export, and final-status logic. No new SSE fields emitted yet (Phase 6).
 * - The old path is never removed until Phase 8 rollout is confirmed stable.
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { store } from '../store';
import { ContactFilter, JobContext, ScrapeDepth } from '../types';
import { geocodeLocation } from '../pipeline/geocoder';
import { resolveCountryIso, getFullRankedCities } from '../pipeline/cityPool';
import { isCityVisited, markCityVisited } from '../pipeline/visitedCities';
import { runPipeline, resetStopSignal, stopSignal } from '../pipeline/pipeline';
import { createStateScheduler } from '../pipeline/stateScheduler';
import { emitStatus, closeSSEConnection } from '../sse';
import { startRateLimiter } from '../middleware/rateLimiter';

export const startRouter = Router();

// Apply rate limiter to POST /api/start (5 requests/minute/IP)
startRouter.use(startRateLimiter);

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_MAX_LEADS = parseInt(process.env.MAX_LEADS ?? '100', 10);

// NOTE: CITY_BATCH_SIZE, INTER_JOB_DELAY_MS, PARALLEL_CITIES_ENABLED,
// PARALLEL_CITIES_MAX, and CITY_ROUND_ROBIN_ENABLED are read inside the
// route handler so that test overrides (process.env mutations) take effect
// without requiring module reload.

// ─── Request Body Shape ───────────────────────────────────────────────────────

interface StartRequestBody {
  // Phase 13: single keyword
  keyword?: unknown;

  // Phase 12: country + states for city-batched runs
  country?: unknown;
  states?: unknown;

  // Backward compat: plain location string (single-location runs)
  location?: unknown;
  locations?: unknown;

  // Stop condition
  maxLeads?: unknown;

  // Scraping options
  depth?: unknown;
  contactFilter?: unknown;
  useSerper?: unknown;
}

// ─── Input Validation ─────────────────────────────────────────────────────────

interface ValidatedInput {
  keyword: string;
  // City-batched mode: country + states[]
  country: string | null;
  states: string[];
  // Legacy single-location mode: resolved location strings
  locations: string[];
  depth: ScrapeDepth;
  contactFilter: ContactFilter;
  maxLeads: number;
  mode: 'city_batched' | 'legacy';
  useSerper: boolean;
}

function validateStartBody(
  body: StartRequestBody
): { valid: true } & ValidatedInput | { valid: false; error: string } {
  const { keyword, country, states, location, locations, depth, contactFilter, maxLeads, useSerper } = body;

  // ── useSerper override ───────────────────────────────────────────────────
  // If provided by the frontend, overrides SERPER_ENABLED env var for this job.
  // If not provided, falls back to the env var setting.
  const useSerperValue = typeof useSerper === 'boolean'
    ? useSerper
    : process.env.SERPER_ENABLED === 'true';

  // ── Keyword: exactly 1 ───────────────────────────────────────────────────
  let kw: string;
  if (typeof keyword === 'string' && keyword.trim().length > 0) {
    kw = keyword.trim();
  } else {
    return { valid: false, error: 'keyword is required and must be a non-empty string. Exactly 1 keyword per run.' };
  }

  // ── maxLeads ─────────────────────────────────────────────────────────────
  let maxLeadsValue = DEFAULT_MAX_LEADS;
  if (maxLeads !== undefined) {
    const parsed = parseInt(String(maxLeads), 10);
    if (isNaN(parsed) || parsed < 1) {
      return { valid: false, error: 'maxLeads must be a positive integer.' };
    }
    maxLeadsValue = parsed;
  }

  // ── Depth ────────────────────────────────────────────────────────────────
  const depthValue = depth ?? 'homepage';
  if (depthValue !== 'homepage' && depthValue !== 'indepth') {
    return { valid: false, error: 'depth must be "homepage" or "indepth"' };
  }

  // ── Contact filter ────────────────────────────────────────────────────────
  const validFilters: ContactFilter[] = ['any', 'email_only', 'phone_only', 'both'];
  const filterValue = (contactFilter ?? 'any') as ContactFilter;
  if (!validFilters.includes(filterValue)) {
    return { valid: false, error: 'contactFilter must be "any", "email_only", "phone_only", or "both"' };
  }

  // ── Mode: city_batched (country + states) vs legacy (location string) ────
  if (country !== undefined || states !== undefined) {
    // City-batched mode
    if (typeof country !== 'string' || country.trim().length === 0) {
      return { valid: false, error: 'country is required when using states-based city batching.' };
    }
    let statesArray: string[] = [];
    if (Array.isArray(states)) {
      statesArray = states
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim());
    } else if (typeof states === 'string' && states.trim().length > 0) {
      statesArray = [states.trim()];
    }
    if (statesArray.length === 0) {
      return { valid: false, error: 'At least one state/region is required for city-batched mode.' };
    }
    return {
      valid: true,
      keyword: kw,
      country: country.trim(),
      states: statesArray,
      locations: [],
      depth: depthValue as ScrapeDepth,
      contactFilter: filterValue,
      maxLeads: maxLeadsValue,
      mode: 'city_batched',
      useSerper: useSerperValue,
    };
  }

  // Legacy mode: plain location string(s)
  let locArray: string[];
  if (Array.isArray(locations)) {
    locArray = locations
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .map((l) => l.trim());
  } else if (typeof location === 'string' && location.trim().length > 0) {
    locArray = [location.trim()];
  } else if (typeof locations === 'string' && (locations as string).trim().length > 0) {
    locArray = [(locations as string).trim()];
  } else {
    return {
      valid: false,
      error: 'Provide either (country + states[]) for city-batched mode, or location/locations for single-location mode.',
    };
  }

  if (locArray.length === 0) {
    return { valid: false, error: 'At least one non-empty location is required.' };
  }
  if (locArray.length > 20) {
    return { valid: false, error: 'Maximum 20 locations allowed in legacy mode.' };
  }

  return {
    valid: true,
    keyword: kw,
    country: null,
    states: [],
    locations: locArray,
    depth: depthValue as ScrapeDepth,
    contactFilter: filterValue,
    maxLeads: maxLeadsValue,
    mode: 'legacy',
    useSerper: useSerperValue,
  };
}

// ─── Inter-job delay helper ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Route Handler ────────────────────────────────────────────────────────────

startRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  // Reject if a job is already running
  if (store.getStatus() === 'running') {
    res.status(409).json({
      error: 'job_already_running',
      message: 'A job is already running. Stop it before starting a new one.',
    });
    return;
  }

  // ── Per-request config (read here so test env overrides take effect) ───────
  const CITY_BATCH_SIZE = parseInt(process.env.CITY_BATCH_SIZE ?? '5', 10);
  const INTER_JOB_DELAY_MS = parseInt(process.env.INTER_JOB_DELAY_MS ?? '0', 10);
  // Phase 5.1: parallel city execution
  const PARALLEL_CITIES_ENABLED = process.env.PARALLEL_CITIES_ENABLED === 'true';
  const PARALLEL_CITIES_MAX = Math.min(
    Math.max(1, parseInt(process.env.PARALLEL_CITIES_MAX ?? '2', 10)),
    4 // hard cap: 4 concurrent city jobs max to avoid browser/memory saturation
  );
  // Round-Robin Scheduler feature flag
  const CITY_ROUND_ROBIN_ENABLED = process.env.CITY_ROUND_ROBIN_ENABLED === 'true';

  // Validate request body
  const validation = validateStartBody(req.body as StartRequestBody);
  if (!validation.valid) {
    res.status(400).json({ error: 'invalid_request', message: validation.error });
    return;
  }

  const { keyword, country, states, locations, depth, contactFilter, maxLeads, mode, useSerper } = validation;

  // Override SERPER_ENABLED for this job based on the frontend toggle.
  // This is a per-request override — it does not persist across jobs.
  process.env.SERPER_ENABLED = useSerper ? 'true' : 'false';
  logger.info(`Discovery mode: ${useSerper ? 'Serper API' : 'Google Maps (Playwright)'}`);

  // Reset store — clears all previous session data
  store.reset();
  resetStopSignal();

  logger.info(
    `Job starting: keyword="${keyword}" mode=${mode} ` +
    (mode === 'city_batched'
      ? `country="${country}" states=${JSON.stringify(states)}`
      : `locations=${JSON.stringify(locations)}`) +
    ` depth="${depth}" contactFilter="${contactFilter}" maxLeads=${maxLeads}`
  );

  // ── City-batched mode (Phase 14) ───────────────────────────────────────────
  if (mode === 'city_batched') {
    // Resolve ISO code directly from country-state-city — no Nominatim needed
    const isoCountryCode = resolveCountryIso(country!);
    logger.info(`Country resolved: "${country}" → ISO=${isoCountryCode}`);

    // Initialise job context
    const ctx = store.initJob(keyword, `${country}`, depth, isoCountryCode, contactFilter, maxLeads);
    store.setStatus('running');
    logger.info(`Job initialised (city_batched): jobId=${ctx.jobId}`);
    res.status(202).json({ jobId: ctx.jobId });

    // ── Async city-batched controller ─────────────────────────────────────
    // Owns: city pool building, batching, stop condition, inter-job delay.
    // pipeline.ts executes a single job only — all orchestration is here.
    //
    // Two execution paths, selected by CITY_ROUND_ROBIN_ENABLED:
    //
    //   false (default) — Flattened batching (original behaviour):
    //     All cities from all states concatenated into one list, processed
    //     in fixed CITY_BATCH_SIZE slices in population order.
    //
    //   true — Round-robin scheduler (stateScheduler.ts):
    //     Each round fetches the next CITY_BATCH_SIZE valid cities from EACH
    //     selected state in selection order, then processes them before the
    //     next round starts. Rounds are strictly sequential.
    //     PARALLEL_CITIES_ENABLED controls concurrency inside a round only.
    //
    // Both paths share: city pool build, SSE schema, store, pipeline, dedup,
    // export, and final-status logic. No new SSE fields yet (Phase 6).
    (async () => {
      try {
        // ── Build per-state city lists ──────────────────────────────────────
        // Both paths need the full ranked city list per state.
        // The flattened path concatenates them; the round-robin path keeps
        // them separate as scheduler selections.
        const perStateCities = states.map((stateName) => ({
          name: stateName,
          rankedCities: getFullRankedCities(isoCountryCode, stateName),
        }));

        const totalCities = perStateCities.reduce((sum, s) => sum + s.rankedCities.length, 0);

        if (totalCities === 0) {
          logger.warn(`City pool empty for country="${country}" states=${JSON.stringify(states)} — stopping`);
          store.setStatus('completed');
          const stats = store.getStats();
          emitStatus(ctx.jobId, { status: 'completed', leadCount: stats.leadCount, discardCount: stats.discardCount });
          closeSSEConnection(ctx.jobId);
          return;
        }

        // totalBatches is an estimate used for SSE batchProgress display.
        // For the round-robin path it represents the maximum possible rounds
        // (largest selection size / batchSize). For the flattened path it is
        // the exact number of slices.
        const totalBatches = Math.ceil(totalCities / CITY_BATCH_SIZE);

        if (PARALLEL_CITIES_ENABLED) {
          logger.info(
            `Parallel city execution enabled — max ${PARALLEL_CITIES_MAX} concurrent city jobs`
          );
        }

        // Shared counters used by both paths for SSE batchProgress.
        let citiesProcessed = 0;
        let currentBatch = 0; // round number for round-robin; slice index for flattened

        // Phase 6: capture final round-robin progress from PATH A for final status emit
        let finalRRProgress: import('../types').SseStatusPayload['roundRobinProgress'] | undefined;

        // ── Helper: dispatch one city job ───────────────────────────────────
        // Shared by both paths. Runs runPipeline(), marks city visited,
        // increments citiesProcessed. Returns immediately if stop/maxLeads hit.
        async function dispatchCity(
          city: import('../types').CityEntry,
          batchNum: number,
        ): Promise<void> {
          if (stopSignal.stopped || store.getLeadCount() >= maxLeads) return;
          const locationStr = `${city.name}, ${city.state}`;
          const iterCtx: JobContext = {
            jobId: ctx.jobId, keyword, location: locationStr,
            depth, isoCountryCode, contactFilter, maxLeads,
          };
          if (!stopSignal.stopped) resetStopSignal();
          store.setStatus('running');
          logger.info(
            `Dispatching: "${locationStr}" (round/batch ${batchNum}/${totalBatches}, ` +
            `city ${citiesProcessed + 1}/${totalCities})`
          );
          await runPipeline(iterCtx, true);
          markCityVisited(keyword, city.name, isoCountryCode);
          citiesProcessed++;
        }

        // ── Helper: run a slice of cities (sequential or parallel) ──────────
        // Used by both paths to execute a set of cities for one round/batch.
        async function runCitySlice(
          citiesToRun: import('../types').CityEntry[],
          batchNum: number,
          roundRobinProgress?: import('../types').SseStatusPayload['roundRobinProgress'],
        ): Promise<void> {
          if (citiesToRun.length === 0) return;

          const statsNow = store.getStats();
          emitStatus(ctx.jobId, {
            status: 'running',
            leadCount: statsNow.leadCount,
            discardCount: statsNow.discardCount,
            activeKeyword: keyword,
            activeLocation: citiesToRun.map((c) => c.name).join(', '),
            batchProgress: { currentBatch: batchNum, totalBatches, citiesProcessed, totalCities },
            roundRobinProgress,
          });

          if (PARALLEL_CITIES_ENABLED) {
            // Run up to PARALLEL_CITIES_MAX cities concurrently within this slice.
            // Rounds are still sequential — this only parallelises inside one round.
            for (let p = 0; p < citiesToRun.length; p += PARALLEL_CITIES_MAX) {
              if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break;
              const chunk = citiesToRun.slice(p, p + PARALLEL_CITIES_MAX);
              await Promise.allSettled(chunk.map((city) => dispatchCity(city, batchNum)));
              if (INTER_JOB_DELAY_MS > 0 && !stopSignal.stopped && store.getLeadCount() < maxLeads) {
                logger.info(`Inter-job delay: ${INTER_JOB_DELAY_MS}ms`);
                await sleep(INTER_JOB_DELAY_MS);
              }
            }
          } else {
            // Sequential execution — original behaviour.
            for (const city of citiesToRun) {
              if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break;
              await dispatchCity(city, batchNum);
              if (INTER_JOB_DELAY_MS > 0 && !stopSignal.stopped && store.getLeadCount() < maxLeads) {
                logger.info(`Inter-job delay: ${INTER_JOB_DELAY_MS}ms`);
                await sleep(INTER_JOB_DELAY_MS);
              }
            }
          }
        }

        // ══════════════════════════════════════════════════════════════════════
        // PATH A — Round-Robin Scheduler (CITY_ROUND_ROBIN_ENABLED=true)
        // ══════════════════════════════════════════════════════════════════════
        if (CITY_ROUND_ROBIN_ENABLED) {
          logger.info(
            `Round-robin scheduler ENABLED — ${states.length} selection(s), ` +
            `batchSize=${CITY_BATCH_SIZE}, totalCities=${totalCities}`
          );

          const scheduler = createStateScheduler({
            selections: perStateCities,
            batchSize: CITY_BATCH_SIZE,
            // isVisited is injected — scheduler never calls isCityVisited directly.
            // Evaluated lazily per city as the scheduler advances each cursor.
            isVisited: (city) => isCityVisited(keyword, city.name, isoCountryCode),
          });

          // ── Round loop — strictly sequential ───────────────────────────────
          // Rule: Round N+1 never starts before all Round N jobs complete.
          // PARALLEL_CITIES_ENABLED only controls concurrency inside runCitySlice.
          roundLoop: while (true) {
            if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break;

            const round = scheduler.nextRound();
            currentBatch = round.roundNumber;

            // allExhausted with no cities means the scheduler had nothing left
            // to produce even before this round started (all cursors already at end).
            // If cities IS non-empty, dispatch them even if allExhausted is true —
            // those are the last cities from selections that exhausted this round.
            if (round.allExhausted && round.cities.length === 0) {
              logger.info(`Round-robin: all selections exhausted after round ${round.roundNumber - 1}`);
              break;
            }

            if (round.cities.length === 0) {
              // All cities in this round were visited — advance to next round
              logger.info(`Round-robin: round ${round.roundNumber} — all cities visited, advancing`);
              continue;
            }

            if (round.newlyExhausted.length > 0) {
              logger.info(
                `Round-robin: round ${round.roundNumber} — selections exhausted: [${round.newlyExhausted.join(', ')}]`
              );
            }

            logger.info(
              `Round-robin: round ${round.roundNumber}/${totalBatches} — ` +
              `${round.cities.length} cities: [${round.cities.map((sc) => sc.city.name).join(', ')}]`
            );

            // Extract plain CityEntry array for runCitySlice
            const citiesToRun = round.cities.map((sc) => sc.city);

            // Build roundRobinProgress from scheduler snapshot for SSE
            const snap = scheduler.snapshot();
            const rrProgress: import('../types').SseStatusPayload['roundRobinProgress'] = {
              currentRound: round.roundNumber,
              selections: snap.selections.map((s) => ({
                name: s.name,
                citiesYielded: s.citiesYielded,
                totalCities: s.totalCities,
                exhausted: s.exhausted,
              })),
            };

            await runCitySlice(citiesToRun, round.roundNumber, rrProgress);

            if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break roundLoop;

            // After dispatching, check if all selections are now exhausted
            if (round.allExhausted) {
              logger.info(`Round-robin: all selections exhausted after round ${round.roundNumber}`);
              break;
            }
          }

          // Capture final scheduler state for the shared final-status emit
          const finalSnap = scheduler.snapshot();
          finalRRProgress = {
            currentRound: finalSnap.currentRound,
            selections: finalSnap.selections.map((s) => ({
              name: s.name,
              citiesYielded: s.citiesYielded,
              totalCities: s.totalCities,
              exhausted: s.exhausted,
            })),
          };

        // ══════════════════════════════════════════════════════════════════════
        // PATH B — Flattened Batching (CITY_ROUND_ROBIN_ENABLED=false, default)
        // ══════════════════════════════════════════════════════════════════════
        } else {
          logger.info(
            `Flattened city batching — ${totalCities} cities across ${states.length} state(s) ` +
            `(${totalBatches} batches)`
          );

          // Flatten all per-state city lists into one ordered array
          const fullCityList: import('../types').CityEntry[] = [];
          for (const sel of perStateCities) {
            fullCityList.push(...sel.rankedCities);
          }

          let batchPointer = 0;

          outer: while (batchPointer < totalCities) {
            if (stopSignal.stopped) break;

            const batch = fullCityList.slice(batchPointer, batchPointer + CITY_BATCH_SIZE);
            batchPointer += CITY_BATCH_SIZE;
            currentBatch++;

            logger.info(
              `Batch ${currentBatch}/${totalBatches}: [${batch.map((c) => c.name).join(', ')}]`
            );

            // Filter out visited cities before dispatching
            const citiesToRun = batch.filter((city) => {
              if (stopSignal.stopped) return false;
              if (store.getLeadCount() >= maxLeads) return false;
              if (isCityVisited(keyword, city.name, isoCountryCode)) {
                logger.info(
                  `VisitedCities: skipping "${city.name}, ${city.state}" — ` +
                  `already scraped for "${keyword}" within window`
                );
                citiesProcessed++;
                return false;
              }
              return true;
            });

            if (citiesToRun.length === 0) continue;
            if (stopSignal.stopped || store.getLeadCount() >= maxLeads) break outer;

            await runCitySlice(citiesToRun, currentBatch);
          }
        }

        // ── Final status (shared by both paths) ─────────────────────────────
        const finalLeads = store.getLeadCount();
        const wasStopped = stopSignal.stopped || store.getStatus() === 'stopped';
        const finalStatus: 'completed' | 'stopped' = wasStopped ? 'stopped' : 'completed';

        if (!wasStopped && finalLeads < maxLeads) {
          logger.info(
            `All cities exhausted (${citiesProcessed}/${totalCities}). ` +
            `Collected ${finalLeads}/${maxLeads} leads. ` +
            `To get more leads, add more states or change the keyword.`
          );
        } else if (!wasStopped) {
          logger.info(`Target reached: ${finalLeads} leads collected.`);
        }

        store.setStatus(finalStatus);
        const finalStats = store.getStats();
        emitStatus(ctx.jobId, {
          status: finalStatus,
          leadCount: finalStats.leadCount,
          discardCount: finalStats.discardCount,
          batchProgress: { currentBatch, totalBatches, citiesProcessed, totalCities },
          roundRobinProgress: finalRRProgress,
        });
        closeSSEConnection(ctx.jobId);
      } catch (err) {
        logger.error(`City-batched controller error: ${(err as Error).message}`);
        store.setStatus('error');
        const stats = store.getStats();
        emitStatus(ctx.jobId, { status: 'error', leadCount: stats.leadCount, discardCount: stats.discardCount });
        closeSSEConnection(ctx.jobId);
      }
    })();

    return;
  }

  // ── Legacy mode: plain location string(s) ─────────────────────────────────
  // Backward compatible — single or multiple explicit location strings.
  const geocodeResults = new Map<string, string>(); // location → isoCountryCode
  for (const loc of locations) {
    try {
      const geocodeResult = await geocodeLocation(loc);
      geocodeResults.set(loc, geocodeResult.isoCountryCode);
      logger.info(`Geocode success: "${loc}" → ISO=${geocodeResult.isoCountryCode || '(unknown)'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Location could not be resolved';
      logger.warn(`Geocode failed for "${loc}": ${message}`);
      res.status(422).json({ error: 'invalid_location', message: `Location "${loc}": ${message}` });
      return;
    }
  }

  const ctx = store.initJob(
    keyword,
    locations[0],
    depth,
    geocodeResults.get(locations[0]) ?? '',
    contactFilter,
    maxLeads
  );
  store.setStatus('running');
  logger.info(`Job initialised (legacy): jobId=${ctx.jobId}`);
  res.status(202).json({ jobId: ctx.jobId });

  // ── Legacy multi-location pipeline (async, non-blocking) ──────────────────
  (async () => {
    try {
      for (let i = 0; i < locations.length; i++) {
        if (store.getStatus() === 'stopped') break;
        if (store.getLeadCount() >= maxLeads) break;

        const loc = locations[i];
        const isoCode = geocodeResults.get(loc) ?? '';
        const iterCtx: JobContext = {
          jobId: ctx.jobId,
          keyword,
          location: loc,
          depth,
          isoCountryCode: isoCode,
          contactFilter,
          maxLeads,
        };

        if (i > 0) {
          store.setStatus('running');
          resetStopSignal();
        }

        logger.info(`Legacy run ${i + 1}/${locations.length} — keyword="${keyword}" location="${loc}"`);

        const isLastRun = i === locations.length - 1;
        await runPipeline(iterCtx, !isLastRun);

        if (INTER_JOB_DELAY_MS > 0 && !isLastRun && store.getStatus() !== 'stopped') {
          await sleep(INTER_JOB_DELAY_MS);
        }
      }
    } catch (err) {
      logger.error(`Legacy pipeline error: ${(err as Error).message}`);
      store.setStatus('error');
    }
  })();
});

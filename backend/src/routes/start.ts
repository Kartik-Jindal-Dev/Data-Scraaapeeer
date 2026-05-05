/**
 * routes/start.ts
 * POST /api/start
 *
 * Validates the job request, geocodes the location(s) via Nominatim (free),
 * initialises the store, and kicks off the scrape pipeline.
 *
 * FREE STACK: Nominatim for geocoding. Playwright for discovery.
 * No Outscraper. No Google Geocoding API.
 *
 * CONSTRAINTS:
 * - Location must be validated via Nominatim BEFORE any scraping begins.
 * - store.reset() is called at the start of every new job.
 * - A running job must be stopped before a new one can start.
 * - C1: Accepts keywords[] and locations[] arrays (max 5 each).
 *   All combinations are run sequentially in a single job.
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { store } from '../store';
import { JobContext, ScrapeDepth } from '../types';
import { geocodeLocation } from '../pipeline/geocoder';
import { runPipeline, resetStopSignal } from '../pipeline/pipeline';
import { startRateLimiter } from '../middleware/rateLimiter';

export const startRouter = Router();

// Apply rate limiter to POST /api/start (5 requests/minute/IP)
startRouter.use(startRateLimiter);

// ─── Request Body Shape ───────────────────────────────────────────────────────

interface StartRequestBody {
  keyword?: unknown;
  keywords?: unknown;
  location?: unknown;
  locations?: unknown;
  depth?: unknown;
}

// ─── Input Validation ─────────────────────────────────────────────────────────

function validateStartBody(body: StartRequestBody): {
  valid: true;
  keywords: string[];
  locations: string[];
  depth: ScrapeDepth;
} | { valid: false; error: string } {
  const { keyword, keywords, location, locations, depth } = body;

  // ── Normalise keywords to array ──────────────────────────────────────────
  let kwArray: string[];
  if (Array.isArray(keywords)) {
    kwArray = keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.trim());
  } else if (typeof keyword === 'string' && keyword.trim().length > 0) {
    kwArray = [keyword.trim()];
  } else if (typeof keywords === 'string' && (keywords as string).trim().length > 0) {
    kwArray = [(keywords as string).trim()];
  } else {
    return { valid: false, error: 'keyword (or keywords array) is required and must be non-empty' };
  }

  if (kwArray.length === 0) {
    return { valid: false, error: 'At least one non-empty keyword is required' };
  }
  if (kwArray.length > 5) {
    return { valid: false, error: 'Maximum 5 keywords allowed' };
  }

  // ── Normalise locations to array ─────────────────────────────────────────
  let locArray: string[];
  if (Array.isArray(locations)) {
    locArray = locations.filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .map((l) => l.trim());
  } else if (typeof location === 'string' && location.trim().length > 0) {
    locArray = [location.trim()];
  } else if (typeof locations === 'string' && (locations as string).trim().length > 0) {
    locArray = [(locations as string).trim()];
  } else {
    return { valid: false, error: 'location (or locations array) is required and must be non-empty' };
  }

  if (locArray.length === 0) {
    return { valid: false, error: 'At least one non-empty location is required' };
  }
  if (locArray.length > 5) {
    return { valid: false, error: 'Maximum 5 locations allowed' };
  }

  // ── Depth ────────────────────────────────────────────────────────────────
  const depthValue = depth ?? 'homepage';
  if (depthValue !== 'homepage' && depthValue !== 'indepth') {
    return { valid: false, error: 'depth must be "homepage" or "indepth"' };
  }

  return {
    valid: true,
    keywords: kwArray,
    locations: locArray,
    depth: depthValue as ScrapeDepth,
  };
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

  // Validate request body
  const validation = validateStartBody(req.body as StartRequestBody);
  if (!validation.valid) {
    res.status(400).json({ error: 'invalid_request', message: validation.error });
    return;
  }

  const { keywords, locations, depth } = validation;

  // Reset store — clears all previous session data
  store.reset();
  resetStopSignal();

  logger.info(
    `Job starting: keywords=${JSON.stringify(keywords)} locations=${JSON.stringify(locations)} depth="${depth}"`
  );

  // ── Geocode ALL locations upfront (fail fast if any invalid) ───────────────
  const geocodeResults = new Map<string, string>(); // location → isoCountryCode
  for (const loc of locations) {
    try {
      const geocodeResult = await geocodeLocation(loc);
      geocodeResults.set(loc, geocodeResult.isoCountryCode);
      logger.info(`Geocode success: "${loc}" → ISO=${geocodeResult.isoCountryCode || '(unknown)'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Location could not be resolved';
      logger.warn(`Geocode failed for "${loc}": ${message}`);
      res.status(422).json({
        error: 'invalid_location',
        message: `Location "${loc}": ${message}`,
      });
      return;
    }
  }

  // Initialise job context in store (using first keyword + location for jobId)
  const ctx = store.initJob(keywords[0], locations[0], depth, geocodeResults.get(locations[0]) ?? '');
  store.setStatus('running');

  logger.info(`Job initialised: jobId=${ctx.jobId}`);

  // Respond immediately with jobId — pipeline runs asynchronously
  res.status(202).json({ jobId: ctx.jobId });

  // ── Multi-run pipeline (async, non-blocking) ────────────────────────────────
  // Runs all keyword × location combinations sequentially.
  // The dedup Set persists across all runs (cleared only by store.reset()).
  (async () => {
    try {
      const combinations: Array<{ kw: string; loc: string; isoCode: string }> = [];
      for (const kw of keywords) {
        for (const loc of locations) {
          combinations.push({ kw, loc, isoCode: geocodeResults.get(loc) ?? '' });
        }
      }

      for (let i = 0; i < combinations.length; i++) {
        if (store.getStatus() === 'stopped') break;

        const { kw, loc, isoCode } = combinations[i];
        const iterCtx: JobContext = {
          jobId: ctx.jobId,
          keyword: kw,
          location: loc,
          depth,
          isoCountryCode: isoCode,
        };

        // For intermediate runs, reset status to running so runPipeline
        // doesn't immediately see 'completed' from the previous run
        if (i > 0) {
          store.setStatus('running');
          resetStopSignal();
        }

        logger.info(
          `Multi-run: starting combination ${i + 1}/${combinations.length} — keyword="${kw}" location="${loc}"`
        );

        await runPipeline(iterCtx);
      }
    } catch (err) {
      logger.error(`Multi-run pipeline error: ${(err as Error).message}`);
      store.setStatus('error');
    }
  })();
});

/**
 * routes/status.ts
 * GET /api/status
 *
 * Returns the current job status, lead count, discard count,
 * failure metrics, and job context.
 *
 * CONSTRAINTS:
 * - Failure metrics are exposed here alongside lead/discard counts.
 * - No PII beyond business name and website URL is ever logged or returned.
 */

import { Request, Response, Router } from 'express';
import { store } from '../store';

export const statusRouter = Router();

// ─── Route Handler ────────────────────────────────────────────────────────────

statusRouter.get('/', (_req: Request, res: Response): void => {
  const stats = store.getStats();

  res.status(200).json({
    status: stats.jobStatus,
    leadCount: stats.leadCount,
    discardCount: stats.discardCount,
    failureMetrics: stats.failureMetrics,
    jobContext: stats.jobContext
      ? {
          jobId: stats.jobContext.jobId,
          keyword: stats.jobContext.keyword,
          location: stats.jobContext.location,
          depth: stats.jobContext.depth,
          // isoCountryCode intentionally omitted from public response
        }
      : null,
  });
});

/**
 * routes/stream.ts
 * GET /api/stream
 *
 * Server-Sent Events endpoint. Clients connect here to receive real-time
 * lead, discard, status, and error events as the job runs.
 *
 * CONSTRAINTS (from requirements.md §11):
 * - Accepts GET /api/stream?jobId=<id>
 * - Only one active connection per jobId — new connection closes the old one.
 * - Connections are closed on job stop and job completion.
 * - SSE `lead` events carry public fields only (no _hasBoth, no _qualityTier).
 * - Sends an immediate `status` event on connect so the client knows current state.
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { registerSSEConnection } from '../sse';
import { store } from '../store';

export const streamRouter = Router();

// ─── Route Handler ────────────────────────────────────────────────────────────

streamRouter.get('/', (req: Request, res: Response): void => {
  const { jobId } = req.query;

  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    res.status(400).json({
      error: 'missing_job_id',
      message: 'jobId query parameter is required',
    });
    return;
  }

  // Validate that the jobId matches the current job context
  const ctx = store.getJobContext();
  if (!ctx || ctx.jobId !== jobId) {
    res.status(404).json({
      error: 'job_not_found',
      message: `No active job found with jobId: ${jobId}`,
    });
    return;
  }

  logger.info(`SSE: new connection request for job ${jobId}`);

  // Register the connection (closes any existing connection for this jobId)
  registerSSEConnection(jobId, res);

  // Send an immediate status event so the client knows the current state
  const stats = store.getStats();
  const statusPayload = {
    status: stats.jobStatus,
    leadCount: stats.leadCount,
    discardCount: stats.discardCount,
  };

  // Write directly since emitStatus uses the registered connection
  res.write(`event: status\n`);
  res.write(`data: ${JSON.stringify(statusPayload)}\n\n`);
});

/**
 * routes/stop.ts
 * POST /api/stop
 *
 * Gracefully terminates the running job within a hard 10-second timeout.
 * Preserves the leads[] array so the operator can still export after stopping.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §6):
 * - Must result in full job termination within 10 seconds.
 * - After 10 seconds, force-closes ALL Playwright browser contexts.
 * - leads[] array is preserved after stop — export still works.
 * - Job status is set to `stopped`.
 * - SSE connection for the job is closed after stop.
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { store } from '../store';
import { closeSSEConnection, emitStatus } from '../sse';
import { signalStop, stopSignal } from '../pipeline/pipeline';
import { forceCloseBrowser } from '../pipeline/discovery';

export const stopRouter = Router();

/** Hard timeout for job termination in milliseconds. */
const STOP_TIMEOUT_MS = 10_000;

// ─── Stop Handler ─────────────────────────────────────────────────────────────

async function handleStop(jobId: string): Promise<void> {
  logger.info(`Stop requested: jobId=${jobId}`);

  // Signal the pipeline and discovery loop to stop
  signalStop();

  // Wait for the pipeline to notice the stop signal naturally,
  // with a hard 10-second timeout before force-closing.
  const drainPromise = new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      // Pipeline sets status to 'stopped' when it finishes cleanly
      if (store.getStatus() === 'stopped' || store.getStatus() === 'completed') {
        clearInterval(interval);
        resolve();
      }
    }, 200);
  });

  const timeoutPromise = new Promise<void>((resolve) =>
    setTimeout(resolve, STOP_TIMEOUT_MS)
  );

  await Promise.race([drainPromise, timeoutPromise]);

  // Force-close all Playwright browser contexts regardless of in-flight state
  logger.info('Stop: force-closing browser contexts');
  await forceCloseBrowser();

  // Ensure status is set to stopped (may already be set by pipeline)
  if (store.getStatus() === 'running') {
    store.setStatus('stopped');
  }

  const stats = store.getStats();
  logger.info(
    `Job stopped: jobId=${jobId} leads=${stats.leadCount} discarded=${stats.discardCount}`
  );

  // Emit final status and close SSE connection
  emitStatus(jobId, {
    status: 'stopped',
    leadCount: stats.leadCount,
    discardCount: stats.discardCount,
  });
  closeSSEConnection(jobId);
}

// ─── Route Handler ────────────────────────────────────────────────────────────

stopRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  const currentStatus = store.getStatus();

  if (currentStatus !== 'running') {
    res.status(409).json({
      error: 'no_running_job',
      message: `No running job to stop. Current status: ${currentStatus}`,
    });
    return;
  }

  const ctx = store.getJobContext();
  if (!ctx) {
    res.status(500).json({
      error: 'internal_error',
      message: 'Job context not found despite running status',
    });
    return;
  }

  // Respond immediately — stop proceeds in background
  const stats = store.getStats();
  res.status(200).json({
    message: 'Stop signal sent. Job will terminate within 10 seconds.',
    leadCount: stats.leadCount,
    discardCount: stats.discardCount,
  });

  handleStop(ctx.jobId).catch((err) => {
    logger.error(`Stop handler error: ${(err as Error).message}`);
    store.setStatus('error');
  });
});

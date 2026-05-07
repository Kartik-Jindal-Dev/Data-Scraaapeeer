/**
 * routes/exportStream.ts
 * GET /api/export/stream
 *
 * Phase 5.4 — Streaming Export API:
 * Returns current leads as a .xlsx download at any point during a job run,
 * including while the job is still running. Allows operators to access
 * partial results without waiting for job completion.
 *
 * Differences from GET /api/export:
 * - Available during 'running' status (not just 'stopped'/'completed')
 * - Always uses streaming writer (no buffer threshold)
 * - Filename includes 'partial' suffix when job is still running
 * - Returns 204 (no content) instead of 404 when leads array is empty
 *   during a running job (leads may arrive soon)
 *
 * CONSTRAINTS:
 * - Same column layout and sort order as /api/export
 * - Internal fields never included
 * - Does NOT stop or affect the running job
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { generateExcelBuffer, generateExcelStreaming, shouldUseStreaming } from '../exporter';
import { store } from '../store';

export const exportStreamRouter = Router();

exportStreamRouter.get('/', async (_req: Request, res: Response): Promise<void> => {
  const status = store.getStatus();

  if (status === 'idle') {
    res.status(409).json({
      error: 'no_data',
      message: 'No job has been run yet. Start a job first.',
    });
    return;
  }

  const leads = store.getLeads();

  // During a running job with no leads yet — return 204 (not an error, just empty so far)
  if (leads.length === 0 && status === 'running') {
    res.status(204).end();
    return;
  }

  if (leads.length === 0) {
    res.status(404).json({
      error: 'no_leads',
      message: 'No qualifying leads found. Nothing to export.',
    });
    return;
  }

  const isPartial = status === 'running';
  const filename = `leads-${isPartial ? 'partial-' : ''}${Date.now()}.xlsx`;
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  logger.info(
    `Export/stream requested: ${leads.length} leads, status=${status}, partial=${isPartial}`
  );

  try {
    if (shouldUseStreaming(leads.length)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');
      if (isPartial) res.setHeader('X-Partial-Results', 'true');

      await generateExcelStreaming(leads, res);
    } else {
      const buffer = await generateExcelBuffer(leads);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length.toString());
      if (isPartial) res.setHeader('X-Partial-Results', 'true');
      res.end(buffer);
    }

    logger.info(`Export/stream complete: ${leads.length} leads → ${filename}`);
  } catch (err) {
    logger.error(`Export/stream error: ${(err as Error).message}`);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'export_failed',
        message: 'Failed to generate Excel file',
      });
    }
  }
});

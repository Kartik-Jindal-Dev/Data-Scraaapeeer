/**
 * routes/export.ts
 * GET /api/export
 *
 * Generates and streams the leads as a .xlsx file download.
 * Supports optional job_id query parameter for exporting specific job leads from history.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §9 + requirements.md §13):
 * - Only .xlsx format — no CSV, JSON, PDF.
 * - Columns: Business Name, Email, Phone, Website, Address (exactly these five).
 * - Internal fields (_hasBoth, _qualityTier) are NEVER included.
 * - Sort: Tier 1 leads (both email + phone) appear first — green highlighted rows.
 * - Streaming writer used internally when leads.length > 500 (no UI change).
 * - The leads[] array is NOT modified during or after export.
 * - Export is available when job status is `stopped` or `completed` (or when job_id is provided).
 */

import { Request, Response, Router } from 'express';
import { logger } from '../logger';
import {
  generateExcelBuffer,
  generateExcelStreaming,
  shouldUseStreaming,
} from '../exporter';
import { store } from '../store';
import { LeadRepository } from '../repositories/LeadRepository';
import { JobRepository } from '../repositories/JobRepository';

export const exportRouter = Router();

// ─── Route Handler ────────────────────────────────────────────────────────────

exportRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  const jobId = req.query.job_id as string | undefined;

  let leads;

  if (jobId) {
    // ── Export from specific job (job history) ────────────────────────────────
    const job = JobRepository.findById(jobId);
    if (!job) {
      res.status(404).json({
        error: 'job_not_found',
        message: `Job with ID ${jobId} not found.`,
      });
      return;
    }

    leads = LeadRepository.findAll({ jobId });

    if (leads.length === 0) {
      res.status(404).json({
        error: 'no_leads',
        message: 'No leads found for this job.',
      });
      return;
    }
  } else {
    // ── Export from current session (in-memory) ───────────────────────────────
    const status = store.getStatus();

    if (status === 'idle') {
      res.status(409).json({
        error: 'no_data',
        message: 'No job has been run yet. Start a job first.',
      });
      return;
    }

    if (status === 'running') {
      res.status(409).json({
        error: 'job_running',
        message: 'Job is still running. Stop or wait for completion before exporting.',
      });
      return;
    }

    leads = store.getLeads();

    if (leads.length === 0) {
      res.status(404).json({
        error: 'no_leads',
        message: 'No qualifying leads found. Nothing to export.',
      });
      return;
    }
  }

  const filename = jobId
    ? `leads-job-${jobId.slice(0, 8)}-${Date.now()}.xlsx`
    : `leads-${Date.now()}.xlsx`;

  const contentType =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  logger.info(`Export requested: ${leads.length} leads, streaming=${shouldUseStreaming(leads.length)}`);

  try {
    if (shouldUseStreaming(leads.length)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Transfer-Encoding', 'chunked');

      await generateExcelStreaming(leads, res);
    } else {
      const buffer = await generateExcelBuffer(leads);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length.toString());
      res.end(buffer);
    }

    logger.info(`Export complete: ${leads.length} leads → ${filename}`);
  } catch (err) {
    logger.error(`Export error: ${(err as Error).message}`);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'export_failed',
        message: 'Failed to generate Excel file',
      });
    }
  }
});
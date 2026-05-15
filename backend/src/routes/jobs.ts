/**
 * routes/jobs.ts
 * Job history and management endpoints.
 *
 * GET /api/jobs - List all jobs with pagination
 * GET /api/jobs/:id - Get job details
 * GET /api/jobs/:id/leads - Get leads for a specific job
 * DELETE /api/jobs/:id - Archive/delete a job
 */

import { Request, Response, Router } from "express";
import { JobRepository } from "../repositories/JobRepository";
import { LeadRepository } from "../repositories/LeadRepository";

export const jobsRouter = Router();

// ─── GET /api/jobs/stats - Aggregate Stats ─────────────────────────────────────

jobsRouter.get("/stats", (_req: Request, res: Response): void => {
  try {
    const stats = JobRepository.getAllStats();
    res.status(200).json(stats);
  } catch (error) {
    console.error("[Jobs API] Error getting stats:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// ─── GET /api/jobs - List Jobs with Pagination ─────────────────────────────────

jobsRouter.get("/", (req: Request, res: Response): void => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const status = req.query.status as string | undefined;

    // Validate pagination parameters
    if (limit < 1 || limit > 100) {
      res.status(400).json({ error: "Limit must be between 1 and 100" });
      return;
    }

    if (offset < 0) {
      res.status(400).json({ error: "Offset must be non-negative" });
      return;
    }

    const jobs = JobRepository.findAll({
      status: status as any,
      limit,
      offset,
    });
    const totalCount = JobRepository.countAll(status as any);

    res.status(200).json({
      jobs,
      pagination: {
        limit,
        offset,
        total: totalCount,
        hasMore: offset + jobs.length < totalCount,
      },
    });
  } catch (error) {
    console.error("[Jobs API] Error listing jobs:", error);
    res.status(500).json({ error: "Failed to list jobs" });
  }
});

// ─── GET /api/jobs/:id - Get Job Details ─────────────────────────────────────────

jobsRouter.get("/:id", (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const job = JobRepository.findById(id);

    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const stats = JobRepository.getJobStats(id);

    res.status(200).json({
      ...job,
      stats: stats || null,
    });
  } catch (error) {
    console.error("[Jobs API] Error getting job details:", error);
    res.status(500).json({ error: "Failed to get job details" });
  }
});

// ─── GET /api/jobs/:id/leads - Get Leads for a Job ───────────────────────────────

jobsRouter.get("/:id/leads", (req: Request, res: Response): void => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    // Validate pagination parameters
    if (limit < 1 || limit > 1000) {
      res.status(400).json({ error: "Limit must be between 1 and 1000" });
      return;
    }

    if (offset < 0) {
      res.status(400).json({ error: "Offset must be non-negative" });
      return;
    }

    // Check if job exists
    const job = JobRepository.findById(id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const leads = LeadRepository.findByJobId(id);
    const totalCount = LeadRepository.countByJobId(id);

    // Apply pagination
    const paginatedLeads = leads.slice(offset, offset + limit);

    res.status(200).json({
      leads: paginatedLeads,
      pagination: {
        limit,
        offset,
        total: totalCount,
        hasMore: offset + paginatedLeads.length < totalCount,
      },
    });
  } catch (error) {
    console.error("[Jobs API] Error getting job leads:", error);
    res.status(500).json({ error: "Failed to get job leads" });
  }
});

// ─── DELETE /api/jobs/:id - Archive/Delete a Job ───────────────────────────────

jobsRouter.delete("/:id", (req: Request, res: Response): void => {
  try {
    const { id } = req.params;

    // Check if job exists
    const job = JobRepository.findById(id);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Delete job (cascades to leads and failure metrics)
    const deleted = JobRepository.deleteById(id);

    if (deleted) {
      res.status(200).json({ message: "Job deleted successfully" });
    } else {
      res.status(500).json({ error: "Failed to delete job" });
    }
  } catch (error) {
    console.error("[Jobs API] Error deleting job:", error);
    res.status(500).json({ error: "Failed to delete job" });
  }
});

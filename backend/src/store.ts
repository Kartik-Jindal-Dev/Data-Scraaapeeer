/**
 * store.ts
 * In-memory session store with SQLite persistence for the Lead Generation Scraper.
 *
 * ARCHITECTURE (Phase 21 - Database Integration):
 * - Write-through cache pattern: in-memory leads[] for fast SSE access, DB for persistence
 * - Deduplication now uses persistent SQLite with 15-day rolling window
 * - Job metadata persisted to database for history tracking
 * - store.reset() clears in-memory cache only (DB data persists)
 * - Data survives server restarts (previous limitation fixed)
 */

import { v4 as uuidv4 } from "uuid";
import {
  FailureMetrics,
  JobContext,
  JobStatus,
  Lead,
  ScrapeDepth,
  ContactFilter,
  StoreStats,
} from "./types";
import { LeadRepository } from "./repositories/LeadRepository";
import { JobRepository } from "./repositories/JobRepository";
import { DedupRepository } from "./repositories/DedupRepository";

// ─── Private State ────────────────────────────────────────────────────────────

/** In-memory leads cache for fast SSE access (write-through to DB). */
let leads: Lead[] = [];
let discardCount = 0;
let jobStatus: JobStatus = "idle";
let jobContext: JobContext | null = null;

/** Deduplication now uses persistent SQLite - no in-memory Set needed. */

let failureMetrics: FailureMetrics = {
  discard_no_contact: 0,
  website_unreachable: 0,
  email_not_found: 0,
  phone_not_found: 0,
  duplicate_skipped: 0,
  captcha_blocked: 0,
  subpages_scraped: 0,
  serper_queries: 0,
  serper_failures: 0,
  serper_fallbacks: 0,
  serper_results_used: 0,
};

// ─── Store API ────────────────────────────────────────────────────────────────

export const store = {
  /**
   * Resets in-memory cache only.
   * Database data persists across job runs.
   * Must be called at the start of every new job.
   */
  reset(): void {
    leads = [];
    discardCount = 0;
    jobStatus = "idle";
    jobContext = null;
    failureMetrics = {
      discard_no_contact: 0,
      website_unreachable: 0,
      email_not_found: 0,
      phone_not_found: 0,
      duplicate_skipped: 0,
      captcha_blocked: 0,
      subpages_scraped: 0,
      serper_queries: 0,
      serper_failures: 0,
      serper_fallbacks: 0,
      serper_results_used: 0,
    };
  },

  /**
   * Initialises a new job context.
   * Generates a UUID jobId and stores keyword, location, depth, ISO country code,
   * contact filter mode, and maxLeads target.
   * Also creates a persistent job record in the database.
   */
  initJob(
    keyword: string,
    location: string,
    depth: ScrapeDepth,
    isoCountryCode: string,
    contactFilter: ContactFilter = "any",
    maxLeads = 100,
  ): JobContext {
    const ctx: JobContext = {
      jobId: uuidv4(),
      keyword,
      location,
      depth,
      isoCountryCode,
      contactFilter,
      maxLeads,
    };
    jobContext = ctx;

    // Create persistent job record in database
    JobRepository.create(ctx);

    return ctx;
  },

  // ─── Lead Management ────────────────────────────────────────────────────────

  /**
   * Appends a qualifying lead to the in-memory cache AND database.
   * Write-through pattern: fast in-memory access for SSE, persistent DB for history.
   */
  addLead(lead: Lead): void {
    // Add to in-memory cache for fast SSE access
    leads.push(lead);

    // Persist to database if we have an active job
    if (jobContext) {
      LeadRepository.create(lead, jobContext.jobId, lead._qualityTier);
    }
  },

  /** Increments the discard counter (lead had no email AND no phone). */
  incrementDiscard(): void {
    discardCount++;
  },

  /** Returns a shallow copy of the leads array. Does not modify the original. */
  getLeads(): Lead[] {
    return [...leads];
  },

  /** Returns the current lead count. */
  getLeadCount(): number {
    return leads.length;
  },

  // ─── Deduplication ──────────────────────────────────────────────────────────

  /**
   * Checks whether a dedup key has been seen within the 15-day rolling window.
   * Key format: `${normalizedPhone}|${rootDomain}` (tldts).
   * Returns true if duplicate (should be skipped), false if new.
   * Uses persistent SQLite storage - survives server restarts.
   *
   * CONSTRAINT: If both normalizedPhone and rootDomain are empty,
   * the entry passes through without deduplication (no key can be formed).
   */
  isDuplicate(key: string): boolean {
    return DedupRepository.isDuplicate(key);
  },

  // ─── Failure Metrics ────────────────────────────────────────────────────────

  /** Increments a specific failure metric counter. */
  incrementMetric(metric: keyof FailureMetrics): void {
    failureMetrics[metric]++;
  },

  /** Returns a snapshot copy of the current failure metrics. */
  getFailureMetrics(): FailureMetrics {
    return { ...failureMetrics };
  },

  // ─── Job Status ─────────────────────────────────────────────────────────────

  /**
   * Updates the current job status in memory and database.
   */
  setStatus(status: JobStatus): void {
    jobStatus = status;

    // Update persistent job record if we have an active job
    if (jobContext) {
      JobRepository.updateStatus(jobContext.jobId, status);

      // Update lead/discard counts in database when job completes
      if (status === "completed" || status === "stopped") {
        JobRepository.markCompleted(
          jobContext.jobId,
          leads.length,
          discardCount,
        );
      } else if (status === "error") {
        JobRepository.markError(jobContext.jobId);
      }
    }
  },

  /** Returns the current job status. */
  getStatus(): JobStatus {
    return jobStatus;
  },

  // ─── Stats Snapshot ─────────────────────────────────────────────────────────

  /**
   * Returns a complete stats snapshot.
   * Used by GET /api/status and SSE status events.
   */
  getStats(): StoreStats {
    return {
      leadCount: leads.length,
      discardCount,
      jobStatus,
      failureMetrics: { ...failureMetrics },
      jobContext: jobContext ? { ...jobContext } : null,
    };
  },

  /** Returns the current job context, or null if no job has been initialised. */
  getJobContext(): JobContext | null {
    return jobContext ? { ...jobContext } : null;
  },
};

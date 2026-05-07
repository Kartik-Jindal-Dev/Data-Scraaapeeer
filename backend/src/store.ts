/**
 * store.ts
 * In-memory session store for the Lead Generation Scraper.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md):
 * - All data lives in Node.js process memory ONLY.
 * - No database writes, no file writes, no external caching.
 * - store.reset() clears ALL data — called at the start of every new job.
 * - Data is lost on server restart. Operator must export before restarting.
 * - The dedup Set is scoped to a single job run and cleared on reset().
 */

import { v4 as uuidv4 } from 'uuid';
import {
  FailureMetrics,
  JobContext,
  JobStatus,
  Lead,
  ScrapeDepth,
  ContactFilter,
  StoreStats,
} from './types';

// ─── Private State ────────────────────────────────────────────────────────────

let leads: Lead[] = [];
let discardCount = 0;
let jobStatus: JobStatus = 'idle';
let jobContext: JobContext | null = null;

/** In-memory dedup Set. Key format: `${normalizedPhone}|${rootDomain}` (tldts). */
let dedupSet = new Set<string>();

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
   * Resets ALL session state.
   * Must be called at the start of every new job.
   * Previous session's leads are permanently lost after this call.
   */
  reset(): void {
    leads = [];
    discardCount = 0;
    jobStatus = 'idle';
    jobContext = null;
    dedupSet = new Set<string>();
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
   */
  initJob(
    keyword: string,
    location: string,
    depth: ScrapeDepth,
    isoCountryCode: string,
    contactFilter: ContactFilter = 'any',
    maxLeads = 100
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
    return ctx;
  },

  // ─── Lead Management ────────────────────────────────────────────────────────

  /** Appends a qualifying lead to the in-memory array. */
  addLead(lead: Lead): void {
    leads.push(lead);
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
   * Checks whether a dedup key has been seen in this job run.
   * Key format: `${normalizedPhone}|${rootDomain}` (tldts).
   * Returns true if duplicate (should be skipped), false if new.
   *
   * CONSTRAINT: If both normalizedPhone and rootDomain are empty,
   * the entry passes through without deduplication (no key can be formed).
   */
  isDuplicate(key: string): boolean {
    if (!key || key === '|') return false; // no key — cannot dedup
    if (dedupSet.has(key)) return true;
    dedupSet.add(key);
    return false;
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

  /** Updates the current job status. */
  setStatus(status: JobStatus): void {
    jobStatus = status;
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

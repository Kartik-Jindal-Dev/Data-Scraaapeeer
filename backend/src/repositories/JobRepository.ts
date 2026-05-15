/**
 * JobRepository.ts
 * Repository layer for job CRUD operations using SQLite.
 * Provides persistent storage for scrape job metadata and history.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, transaction } from '../db/db';
import { JobContext, JobStatus, ScrapeDepth, ContactFilter } from '../types';

// ─── Database Job Entity ───────────────────────────────────────────────────────

interface DbJob {
  id: string;
  keyword: string;
  location: string;
  depth: string;
  iso_country_code: string;
  contact_filter: string;
  max_leads: number;
  status: string;
  lead_count: number;
  discard_count: number;
  started_at: number | null;
  completed_at: number | null;
}

// ─── Repository Interface ─────────────────────────────────────────────────────

export const JobRepository = {
  /**
   * Creates a new job in the database.
   * Returns the job ID.
   */
  create(context: JobContext): string {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO jobs (
        id, keyword, location, depth, iso_country_code, contact_filter,
        max_leads, status, lead_count, discard_count, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      context.jobId,
      context.keyword,
      context.location,
      context.depth,
      context.isoCountryCode,
      context.contactFilter,
      context.maxLeads,
      'idle',
      0,
      0,
      now,
      null
    );

    return context.jobId;
  },

  /**
   * Finds a job by ID.
   * Returns null if not found.
   */
  findById(id: string): JobContext | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
    const row = stmt.get(id) as DbJob | undefined;

    if (!row) return null;
    return this.mapToJobContext(row);
  },

  /**
   * Finds all jobs in the database.
   * Supports pagination with limit and offset.
   * Optionally filtered by status.
   */
  findAll(options: { status?: JobStatus; limit?: number; offset?: number } = {}): JobContext[] {
    const db = getDb();
    const { status, limit = 50, offset = 0 } = options;

    let query = 'SELECT * FROM jobs';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as DbJob[];
    return rows.map(row => this.mapToJobContext(row));
  },

  /**
   * Updates the status of a job.
   */
  updateStatus(id: string, status: JobStatus): boolean {
    const db = getDb();
    const stmt = db.prepare('UPDATE jobs SET status = ? WHERE id = ?');
    const result = stmt.run(status, id);
    return result.changes > 0;
  },

  /**
   * Updates the lead count for a job.
   */
  updateLeadCount(id: string, count: number): boolean {
    const db = getDb();
    const stmt = db.prepare('UPDATE jobs SET lead_count = ? WHERE id = ?');
    const result = stmt.run(count, id);
    return result.changes > 0;
  },

  /**
   * Updates the discard count for a job.
   */
  updateDiscardCount(id: string, count: number): boolean {
    const db = getDb();
    const stmt = db.prepare('UPDATE jobs SET discard_count = ? WHERE id = ?');
    const result = stmt.run(count, id);
    return result.changes > 0;
  },

  /**
   * Marks a job as completed with the completion timestamp.
   */
  markCompleted(id: string, leadCount: number, discardCount: number): boolean {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      UPDATE jobs 
      SET status = ?, lead_count = ?, discard_count = ?, completed_at = ? 
      WHERE id = ?
    `);

    const result = stmt.run('completed', leadCount, discardCount, now, id);
    return result.changes > 0;
  },

  /**
   * Marks a job as stopped with the completion timestamp.
   */
  markStopped(id: string, leadCount: number, discardCount: number): boolean {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      UPDATE jobs 
      SET status = ?, lead_count = ?, discard_count = ?, completed_at = ? 
      WHERE id = ?
    `);

    const result = stmt.run('stopped', leadCount, discardCount, now, id);
    return result.changes > 0;
  },

  /**
   * Marks a job as errored with the completion timestamp.
   */
  markError(id: string): boolean {
    const db = getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      UPDATE jobs 
      SET status = ?, completed_at = ? 
      WHERE id = ?
    `);

    const result = stmt.run('error', now, id);
    return result.changes > 0;
  },

  /**
   * Deletes a job by ID.
   * Cascades to leads and failure metrics due to foreign key constraints.
   */
  deleteById(id: string): boolean {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  },

  /**
   * Counts all jobs in the database.
   * Optionally filtered by status.
   */
  countAll(status?: JobStatus): number {
    const db = getDb();

    if (status) {
      const stmt = db.prepare('SELECT COUNT(*) as count FROM jobs WHERE status = ?');
      const result = stmt.get(status) as { count: number };
      return result.count;
    }

    const stmt = db.prepare('SELECT COUNT(*) as count FROM jobs');
    const result = stmt.get() as { count: number };
    return result.count;
  },

  /**
   * Returns aggregate stats across all jobs.
   */
  getAllStats(): { totalJobs: number; totalLeads: number; totalDiscards: number } {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as totalJobs,
        COALESCE(SUM(lead_count), 0) as totalLeads,
        COALESCE(SUM(discard_count), 0) as totalDiscards
      FROM jobs
    `);
    return stmt.get() as { totalJobs: number; totalLeads: number; totalDiscards: number };
  },

  /**
   * Finds the most recent job.
   */
  findMostRecent(): JobContext | null {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM jobs ORDER BY started_at DESC LIMIT 1');
    const row = stmt.get() as DbJob | undefined;

    if (!row) return null;
    return this.mapToJobContext(row);
  },

  /**
   * Finds jobs by keyword.
   */
  findByKeyword(keyword: string, limit = 20): JobContext[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM jobs 
      WHERE keyword = ? 
      ORDER BY started_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(keyword, limit) as DbJob[];
    return rows.map(row => this.mapToJobContext(row));
  },

  /**
   * Maps a database row to a JobContext domain object.
   */
  mapToJobContext(row: DbJob): JobContext {
    return {
      jobId: row.id,
      keyword: row.keyword,
      location: row.location,
      depth: row.depth as ScrapeDepth,
      isoCountryCode: row.iso_country_code,
      contactFilter: row.contact_filter as ContactFilter,
      maxLeads: row.max_leads,
    };
  },

  /**
   * Gets job statistics (lead count, discard count, status).
   */
  getJobStats(id: string): { leadCount: number; discardCount: number; status: JobStatus } | null {
    const db = getDb();
    const stmt = db.prepare('SELECT lead_count, discard_count, status FROM jobs WHERE id = ?');
    const row = stmt.get(id) as { lead_count: number; discard_count: number; status: string } | undefined;

    if (!row) return null;

    return {
      leadCount: row.lead_count,
      discardCount: row.discard_count,
      status: row.status as JobStatus,
    };
  },
};

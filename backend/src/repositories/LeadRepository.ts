/**
 * LeadRepository.ts
 * Repository layer for lead CRUD operations using SQLite.
 * Provides persistent storage for business leads with job association.
 */

import { v4 as uuidv4 } from "uuid";
import { getDb, transaction } from "../db/db";
import { Lead, QualityTier } from "../types";

// ─── Database Lead Entity ───────────────────────────────────────────────────────

interface DbLead {
  id: string;
  job_id: string;
  business_name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  has_contact_form: number;
  is_generic_email: number;
  is_free_email: number;
  is_relay_email: number;
  quality_tier: string | null;
  created_at: number;
}

// ─── Repository Interface ───────────────────────────────────────────────────────

export const LeadRepository = {
  /**
   * Creates a new lead in the database.
   * Returns the lead ID.
   */
  create(
    lead: Omit<Lead, "_hasBoth" | "_qualityTier">,
    jobId: string,
    qualityTier?: QualityTier,
  ): string {
    const db = getDb();
    const id = uuidv4();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO leads (
        id, job_id, business_name, email, phone, website, address,
        has_contact_form, is_generic_email, is_free_email, is_relay_email,
        quality_tier, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      jobId,
      lead.businessName,
      lead.email,
      lead.phone,
      lead.website,
      lead.address,
      lead.hasContactForm ? 1 : 0,
      lead.isGenericEmail ? 1 : 0,
      lead.isFreeEmail ? 1 : 0,
      lead.isRelayEmail ? 1 : 0,
      qualityTier || null,
      now,
    );

    return id;
  },

  /**
   * Creates multiple leads in a single transaction.
   * More efficient than individual inserts for bulk operations.
   */
  createBulk(
    leads: Array<{
      lead: Omit<Lead, "_hasBoth" | "_qualityTier">;
      jobId: string;
      qualityTier?: QualityTier;
    }>,
  ): void {
    transaction(() => {
      for (const { lead, jobId, qualityTier } of leads) {
        this.create(lead, jobId, qualityTier);
      }
    });
  },

  /**
   * Finds a lead by ID.
   * Returns null if not found.
   */
  findById(id: string): Lead | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM leads WHERE id = ?");
    const row = stmt.get(id) as DbLead | undefined;

    if (!row) return null;
    return this.mapToLead(row);
  },

  /**
   * Finds all leads for a specific job.
   * Returns leads sorted by creation time (newest first).
   */
  findByJobId(jobId: string): Lead[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM leads 
      WHERE job_id = ? 
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(jobId) as DbLead[];
    return rows.map((row) => this.mapToLead(row));
  },

  /**
   * Finds all leads in the database.
   * Optionally filtered by job ID.
   * Supports pagination with limit and offset.
   */
  findAll(
    options: { jobId?: string; limit?: number; offset?: number } = {},
  ): Lead[] {
    const db = getDb();
    const { jobId, limit = 100, offset = 0 } = options;

    let query = "SELECT * FROM leads";
    const params: any[] = [];

    if (jobId) {
      query += " WHERE job_id = ?";
      params.push(jobId);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as DbLead[];
    return rows.map((row) => this.mapToLead(row));
  },

  /**
   * Counts leads for a specific job.
   */
  countByJobId(jobId: string): number {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT COUNT(*) as count FROM leads WHERE job_id = ?",
    );
    const result = stmt.get(jobId) as { count: number };
    return result.count;
  },

  /**
   * Counts all leads in the database.
   * Optionally filtered by job ID.
   */
  countAll(jobId?: string): number {
    const db = getDb();

    if (jobId) {
      const stmt = db.prepare(
        "SELECT COUNT(*) as count FROM leads WHERE job_id = ?",
      );
      const result = stmt.get(jobId) as { count: number };
      return result.count;
    }

    const stmt = db.prepare("SELECT COUNT(*) as count FROM leads");
    const result = stmt.get() as { count: number };
    return result.count;
  },

  /**
   * Deletes all leads for a specific job.
   * Cascades due to foreign key constraint.
   */
  deleteByJobId(jobId: string): number {
    const db = getDb();
    const stmt = db.prepare("DELETE FROM leads WHERE job_id = ?");
    const result = stmt.run(jobId);
    return result.changes;
  },

  /**
   * Deletes a specific lead by ID.
   */
  deleteById(id: string): boolean {
    const db = getDb();
    const stmt = db.prepare("DELETE FROM leads WHERE id = ?");
    const result = stmt.run(id);
    return result.changes > 0;
  },

  /**
   * Maps a database row to a Lead domain object.
   */
  mapToLead(row: DbLead): Lead {
    const hasBoth = row.email !== "" && row.phone !== "";
    const qualityTier: QualityTier =
      (row.quality_tier as QualityTier) || "Tier3";

    return {
      businessName: row.business_name,
      email: row.email,
      phone: row.phone,
      website: row.website,
      address: row.address,
      hasContactForm: row.has_contact_form === 1,
      isGenericEmail: row.is_generic_email === 1,
      isFreeEmail: row.is_free_email === 1,
      isRelayEmail: row.is_relay_email === 1,
      _hasBoth: hasBoth,
      _qualityTier: qualityTier,
    };
  },

  /**
   * Finds leads by quality tier.
   */
  findByQualityTier(tier: QualityTier, limit = 100): Lead[] {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM leads 
      WHERE quality_tier = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(tier, limit) as DbLead[];
    return rows.map((row) => this.mapToLead(row));
  },

  /**
   * Gets lead count by quality tier for a job.
   */
  countByQualityTier(jobId: string): Record<QualityTier, number> {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT quality_tier, COUNT(*) as count 
      FROM leads 
      WHERE job_id = ? 
      GROUP BY quality_tier
    `);
    const rows = stmt.all(jobId) as Array<{
      quality_tier: string;
      count: number;
    }>;

    const result: Record<QualityTier, number> = {
      Tier1: 0,
      Tier2: 0,
      Tier3: 0,
    };

    for (const row of rows) {
      if (row.quality_tier in result) {
        result[row.quality_tier as QualityTier] = row.count;
      }
    }

    return result;
  },
};

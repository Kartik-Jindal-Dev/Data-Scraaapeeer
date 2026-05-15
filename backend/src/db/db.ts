/**
 * db.ts
 * SQLite database connection singleton and schema initialization.
 * Uses better-sqlite3 for synchronous, ACID-compliant database operations.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// ─── Database Path Configuration ─────────────────────────────────────────────────────

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "leads.db");

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// ─── Connection Singleton ─────────────────────────────────────────────────────────

let db: Database.Database | null = null;

/**
 * Returns the singleton database connection.
 * Creates the connection on first call.
 * Enables WAL mode for better concurrency.
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);

    // Enable WAL mode for better concurrent read/write performance
    db.pragma("journal_mode = WAL");

    // Enable foreign keys
    db.pragma("foreign_keys = ON");

    // Initialize schema
    initializeSchema();
  }

  return db;
}

/**
 * Closes the database connection.
 * Should be called on application shutdown.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Schema Initialization ─────────────────────────────────────────────────────────

/**
 * Creates all database tables if they don't exist.
 * Uses IF NOT EXISTS to be safe on repeated calls.
 */
function initializeSchema(): void {
  const database = getDb();

  // Migration tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  // Jobs table
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      location TEXT NOT NULL,
      depth TEXT NOT NULL,
      iso_country_code TEXT NOT NULL,
      contact_filter TEXT NOT NULL,
      max_leads INTEGER NOT NULL,
      status TEXT NOT NULL,
      lead_count INTEGER DEFAULT 0,
      discard_count INTEGER DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER
    );
  `);

  // Leads table
  database.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      business_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      website TEXT,
      address TEXT,
      has_contact_form INTEGER DEFAULT 0,
      is_generic_email INTEGER DEFAULT 0,
      is_free_email INTEGER DEFAULT 0,
      is_relay_email INTEGER DEFAULT 0,
      quality_tier TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
  `);

  // Dedup records table
  database.exec(`
    CREATE TABLE IF NOT EXISTS dedup_records (
      dedup_key TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    );
  `);

  // Failure metrics table
  database.exec(`
    CREATE TABLE IF NOT EXISTS failure_metrics (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      discard_no_contact INTEGER DEFAULT 0,
      website_unreachable INTEGER DEFAULT 0,
      email_not_found INTEGER DEFAULT 0,
      phone_not_found INTEGER DEFAULT 0,
      duplicate_skipped INTEGER DEFAULT 0,
      captcha_blocked INTEGER DEFAULT 0,
      subpages_scraped INTEGER DEFAULT 0,
      serper_queries INTEGER DEFAULT 0,
      serper_failures INTEGER DEFAULT 0,
      serper_fallbacks INTEGER DEFAULT 0,
      serper_results_used INTEGER DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
  `);

  // Create indexes for performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_leads_job_id ON leads(job_id);
    CREATE INDEX IF NOT EXISTS idx_leads_quality_tier ON leads(quality_tier);
    CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at);
    CREATE INDEX IF NOT EXISTS idx_dedup_first_seen_at ON dedup_records(first_seen_at);
  `);

  // Record initial migration
  const currentVersion = getCurrentMigrationVersion();
  if (currentVersion === 0) {
    const stmt = database.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );
    stmt.run(1, Date.now());
  }
}

// ─── Migration System ─────────────────────────────────────────────────────────────

/**
 * Returns the current migration version from the database.
 * Returns 0 if no migrations have been applied.
 */
function getCurrentMigrationVersion(): number {
  const database = getDb();
  const stmt = database.prepare(
    "SELECT MAX(version) as version FROM schema_migrations",
  );
  const result = stmt.get() as { version: number | null };
  return result?.version ?? 0;
}

/**
 * Applies pending migrations.
 * In the future, migration files can be added to a migrations directory.
 */
export function runMigrations(): void {
  const currentVersion = getCurrentMigrationVersion();
  const database = getDb();

  // Future migrations can be added here
  // For now, we're at version 1
  if (currentVersion < 1) {
    // Version 1 is the initial schema (already applied in initializeSchema)
  }
}

// ─── Database Utilities ───────────────────────────────────────────────────────────

/**
 * Executes a transaction callback with automatic rollback on error.
 */
export function transaction<T>(callback: () => T): T {
  const database = getDb();
  const tx = database.transaction(callback);
  return tx();
}

/**
 * Returns database statistics for monitoring.
 */
export function getDbStats(): {
  path: string;
  walMode: boolean;
  pageCount: number;
  pageSize: number;
  totalSize: number;
} {
  const database = getDb();

  const walMode = database.pragma("journal_mode", { simple: true }) === "wal";
  const pageCount = database.pragma("page_count", { simple: true }) as number;
  const pageSize = database.pragma("page_size", { simple: true }) as number;

  const stats = fs.statSync(DB_PATH);

  return {
    path: DB_PATH,
    walMode,
    pageCount,
    pageSize,
    totalSize: stats.size,
  };
}

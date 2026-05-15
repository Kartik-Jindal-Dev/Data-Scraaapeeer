/// <reference types="jest" />
/**
 * LeadRepository.test.ts
 * Unit tests for LeadRepository using in-memory SQLite.
 */

import Database from 'better-sqlite3';
import { LeadRepository } from './LeadRepository';
import * as dbModule from '../db/db';

jest.mock('../db/db', () => {
  const Database = require('better-sqlite3');
  let memDb: any = null;
  return {
    getDb: jest.fn(() => {
      if (!memDb) {
        memDb = new Database(':memory:');
        memDb.pragma('journal_mode = WAL');
        memDb.pragma('foreign_keys = ON');
        memDb.exec(`
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
          CREATE INDEX IF NOT EXISTS idx_leads_job_id ON leads(job_id);
          CREATE INDEX IF NOT EXISTS idx_leads_quality_tier ON leads(quality_tier);
          CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
        `);
      }
      return memDb;
    }),
  };
});

function insertTestJob(jobId: string = 'test-job-1'): void {
  const db = dbModule.getDb();
  db.prepare(`
    INSERT INTO jobs (id, keyword, location, depth, iso_country_code, contact_filter, max_leads, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, 'test', 'location', 'homepage', 'US', 'any', 100, 'completed', Date.now());
}

function makeLeadRow(jobId: string = 'test-job-1'): any {
  return {
    id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    job_id: jobId,
    business_name: 'Acme Corp',
    email: 'info@acme.com',
    phone: '+12025551234',
    website: 'https://acme.com',
    address: '123 Main St',
    has_contact_form: 0,
    is_generic_email: 0,
    is_free_email: 0,
    is_relay_email: 0,
    quality_tier: 'Tier1',
    created_at: Date.now(),
  };
}

describe('LeadRepository', () => {
  beforeEach(() => {
    const db = dbModule.getDb();
    db.exec('DELETE FROM leads');
    db.exec('DELETE FROM jobs');
  });

  afterAll(() => {
    const db = dbModule.getDb();
    db.close();
  });

  describe('create()', () => {
    it('inserts a lead into the database', () => {
      insertTestJob();

      const lead = {
        businessName: 'Acme Corp',
        email: 'info@acme.com',
        phone: '+12025551234',
        website: 'https://acme.com',
        address: '123 Main St',
        hasContactForm: false,
        isGenericEmail: false,
        isFreeEmail: false,
        isRelayEmail: false,
        _hasBoth: true,
        _qualityTier: 'Tier1' as const,
      };

      const id = LeadRepository.create(lead, 'test-job-1', 'Tier1');
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');

      const found = LeadRepository.findByJobId('test-job-1');
      expect(found).toHaveLength(1);
      expect(found[0].businessName).toBe('Acme Corp');
      expect(found[0].email).toBe('info@acme.com');
    });

    it('generates a UUID for each lead', () => {
      insertTestJob();
      const lead = { businessName: 'Beta', email: '', phone: '', website: '', address: '', _hasBoth: false, _qualityTier: 'Tier3' as const };
      const id1 = LeadRepository.create(lead, 'test-job-1', 'Tier3');
      const id2 = LeadRepository.create(lead, 'test-job-1', 'Tier3');
      expect(id1).not.toBe(id2);
    });
  });

  describe('findByJobId()', () => {
    it('returns leads for a specific job', () => {
      insertTestJob('job-a');
      insertTestJob('job-b');

      const lead1 = makeLeadRow('job-a');
      const lead2 = makeLeadRow('job-b');
      const db = dbModule.getDb();
      db.prepare(`INSERT INTO leads (${Object.keys(lead1).join(',')}) VALUES (${Object.keys(lead1).map(() => '?').join(',')})`).run(...Object.values(lead1));
      db.prepare(`INSERT INTO leads (${Object.keys(lead2).join(',')}) VALUES (${Object.keys(lead2).map(() => '?').join(',')})`).run(...Object.values(lead2));

      const leadsA = LeadRepository.findByJobId('job-a');
      expect(leadsA).toHaveLength(1);
      expect(leadsA[0].businessName).toBe('Acme Corp');
    });

    it('returns empty array for job with no leads', () => {
      insertTestJob('empty-job');
      const leads = LeadRepository.findByJobId('empty-job');
      expect(leads).toHaveLength(0);
    });
  });

  describe('findAll()', () => {
    it('returns all leads with pagination', () => {
      insertTestJob();
      const db = dbModule.getDb();
      for (let i = 0; i < 5; i++) {
        const row = makeLeadRow();
        row.business_name = `Company ${i}`;
        db.prepare(`INSERT INTO leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      }

      const all = LeadRepository.findAll();
      expect(all).toHaveLength(5);
    });

    it('filters by jobId', () => {
      insertTestJob('job-a');
      insertTestJob('job-b');
      const db = dbModule.getDb();
      for (let i = 0; i < 3; i++) {
        const row = makeLeadRow('job-a');
        db.prepare(`INSERT INTO leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      }
      for (let i = 0; i < 2; i++) {
        const row = makeLeadRow('job-b');
        db.prepare(`INSERT INTO leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
      }

      const jobBLeads = LeadRepository.findAll({ jobId: 'job-b' });
      expect(jobBLeads).toHaveLength(2);
    });
  });

  describe('countByJobId() / countAll()', () => {
    it('counts leads for a specific job', () => {
      insertTestJob('job-a');
      const db = dbModule.getDb();
      const row = makeLeadRow('job-a');
      db.prepare(`INSERT INTO leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));

      expect(LeadRepository.countByJobId('job-a')).toBe(1);
    });

    it('countAll returns total across all jobs', () => {
      insertTestJob('job-a');
      insertTestJob('job-b');
      const db = dbModule.getDb();
      const rowA = makeLeadRow('job-a');
      const rowB = makeLeadRow('job-b');
      db.prepare(`INSERT INTO leads (${Object.keys(rowA).join(',')}) VALUES (${Object.keys(rowA).map(() => '?').join(',')})`).run(...Object.values(rowA));
      db.prepare(`INSERT INTO leads (${Object.keys(rowB).join(',')}) VALUES (${Object.keys(rowB).map(() => '?').join(',')})`).run(...Object.values(rowB));

      expect(LeadRepository.countAll()).toBe(2);
    });

    it('countAll respects jobId filter', () => {
      insertTestJob('job-a');
      const db = dbModule.getDb();
      const row = makeLeadRow('job-a');
      db.prepare(`INSERT INTO leads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));

      expect(LeadRepository.countAll('job-a')).toBe(1);
      expect(LeadRepository.countAll('no-such-job')).toBe(0);
    });
  });
});
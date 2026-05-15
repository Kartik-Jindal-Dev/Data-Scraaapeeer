/**
 * store.test.ts
 * Unit tests for the in-memory store.
 *
 * Covers:
 * - reset() clears all state
 * - addLead / getLeads / getLeadCount
 * - incrementDiscard
 * - isDuplicate (dedup key logic)
 * - incrementMetric / getFailureMetrics
 * - setStatus / getStatus
 * - initJob / getJobContext
 * - getStats snapshot
 */

import { store } from './store';
import { Lead, QualityTier } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    businessName: 'Acme Corp',
    email: 'info@acme.com',
    phone: '+12025551234',
    website: 'https://acme.com',
    address: '123 Main St, New York, USA',
    _hasBoth: true,
    _qualityTier: 'Tier1' as QualityTier,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  store.reset();
});

describe('store.reset()', () => {
  it('clears leads array', () => {
    store.addLead(makeLead());
    store.reset();
    expect(store.getLeads()).toHaveLength(0);
  });

  it('resets discard count to 0', () => {
    store.incrementDiscard();
    store.reset();
    expect(store.getStats().discardCount).toBe(0);
  });

  it('resets job status to idle', () => {
    store.setStatus('running');
    store.reset();
    expect(store.getStatus()).toBe('idle');
  });

  it('resets all failure metrics to 0', () => {
    store.incrementMetric('discard_no_contact');
    store.incrementMetric('website_unreachable');
    store.reset();
    const metrics = store.getFailureMetrics();
    expect(metrics.discard_no_contact).toBe(0);
    expect(metrics.website_unreachable).toBe(0);
  });

  it('clears job context', () => {
    store.initJob('keyword', 'London', 'homepage', 'GB');
    store.reset();
    expect(store.getJobContext()).toBeNull();
  });

  it('resets dedup set (same key accepted again after reset)', () => {
    store.isDuplicate('+12025551234|acme.com');
    store.reset();
    expect(store.isDuplicate('+12025551234|acme.com')).toBe(false);
  });
});

describe('store.addLead() / getLeads() / getLeadCount()', () => {
  it('adds a lead and returns it', () => {
    const lead = makeLead();
    store.addLead(lead);
    expect(store.getLeads()).toHaveLength(1);
    expect(store.getLeads()[0].businessName).toBe('Acme Corp');
  });

  it('getLeads() returns a copy — mutations do not affect the store', () => {
    store.addLead(makeLead());
    const copy = store.getLeads();
    copy.push(makeLead({ businessName: 'Injected' }));
    expect(store.getLeadCount()).toBe(1);
  });

  it('getLeadCount() returns correct count', () => {
    store.addLead(makeLead());
    store.addLead(makeLead({ businessName: 'Beta Ltd' }));
    expect(store.getLeadCount()).toBe(2);
  });
});

describe('store.incrementDiscard()', () => {
  it('increments discard count', () => {
    store.incrementDiscard();
    store.incrementDiscard();
    expect(store.getStats().discardCount).toBe(2);
  });
});

describe('store.isDuplicate()', () => {
  it('returns false for a new key and adds it to the set', () => {
    expect(store.isDuplicate('+12025551234|acme.com')).toBe(false);
  });

  it('returns true for a key already seen in this run', () => {
    store.isDuplicate('+12025551234|acme.com');
    expect(store.isDuplicate('+12025551234|acme.com')).toBe(true);
  });

  it('returns false for an empty key (no phone, no domain)', () => {
    expect(store.isDuplicate('|')).toBe(false);
    expect(store.isDuplicate('|')).toBe(false); // never deduped
  });

  it('returns false for an empty string key', () => {
    expect(store.isDuplicate('')).toBe(false);
    expect(store.isDuplicate('')).toBe(false);
  });

  it('treats different keys as distinct', () => {
    // Clear DB before this test to avoid cross-test pollution
    DedupRepository.clearAll();
    store.isDuplicate('+12025551234|acme.com');
    expect(store.isDuplicate('+12025551235|acme.com')).toBe(false);
    expect(store.isDuplicate('+12025551234|beta.com')).toBe(false);
  });
});

describe('store.incrementMetric() / getFailureMetrics()', () => {
  it('increments discard_no_contact', () => {
    store.incrementMetric('discard_no_contact');
    expect(store.getFailureMetrics().discard_no_contact).toBe(1);
  });

  it('increments website_unreachable', () => {
    store.incrementMetric('website_unreachable');
    store.incrementMetric('website_unreachable');
    expect(store.getFailureMetrics().website_unreachable).toBe(2);
  });

  it('increments all six metrics independently', () => {
    const metrics: Array<keyof ReturnType<typeof store.getFailureMetrics>> = [
      'discard_no_contact',
      'website_unreachable',
      'email_not_found',
      'phone_not_found',
      'duplicate_skipped',
      'captcha_blocked',
    ];
    metrics.forEach((m) => store.incrementMetric(m));
    const result = store.getFailureMetrics();
    metrics.forEach((m) => expect(result[m]).toBe(1));
  });

  it('getFailureMetrics() returns a copy — mutations do not affect the store', () => {
    store.incrementMetric('captcha_blocked');
    const copy = store.getFailureMetrics();
    copy.captcha_blocked = 999;
    expect(store.getFailureMetrics().captcha_blocked).toBe(1);
  });
});

describe('store.setStatus() / getStatus()', () => {
  it('starts as idle', () => {
    expect(store.getStatus()).toBe('idle');
  });

  it('updates to running', () => {
    store.setStatus('running');
    expect(store.getStatus()).toBe('running');
  });

  it('updates to stopped', () => {
    store.setStatus('stopped');
    expect(store.getStatus()).toBe('stopped');
  });

  it('updates to completed', () => {
    store.setStatus('completed');
    expect(store.getStatus()).toBe('completed');
  });

  it('updates to error', () => {
    store.setStatus('error');
    expect(store.getStatus()).toBe('error');
  });
});

describe('store.initJob() / getJobContext()', () => {
  it('creates a job context with a UUID jobId', () => {
    const ctx = store.initJob('dental clinic', 'London, UK', 'homepage', 'GB');
    expect(ctx.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(ctx.keyword).toBe('dental clinic');
    expect(ctx.location).toBe('London, UK');
    expect(ctx.depth).toBe('homepage');
    expect(ctx.isoCountryCode).toBe('GB');
  });

  it('getJobContext() returns a copy — mutations do not affect the store', () => {
    store.initJob('test', 'Paris', 'indepth', 'FR');
    const ctx = store.getJobContext()!;
    ctx.keyword = 'mutated';
    expect(store.getJobContext()!.keyword).toBe('test');
  });

  it('returns null before any job is initialised', () => {
    expect(store.getJobContext()).toBeNull();
  });
});

describe('store.getStats()', () => {
  it('returns a complete stats snapshot', () => {
    store.initJob('florist', 'Tokyo', 'homepage', 'JP');
    store.setStatus('running');
    store.addLead(makeLead());
    store.incrementDiscard();
    store.incrementMetric('email_not_found');

    const stats = store.getStats();
    expect(stats.leadCount).toBe(1);
    expect(stats.discardCount).toBe(1);
    expect(stats.jobStatus).toBe('running');
    expect(stats.failureMetrics.email_not_found).toBe(1);
    expect(stats.jobContext?.keyword).toBe('florist');
  });
});

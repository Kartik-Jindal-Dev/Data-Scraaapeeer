/**
 * deduplicator.test.ts
 * Unit tests for the deduplicator module.
 *
 * Covers:
 * - extractRootDomain: subdomains, multi-part TLDs, missing protocol, empty input
 * - buildDedupKey: key format
 * - isDuplicateLead: new lead passes, duplicate skipped, no-key passes through
 * - Rolling window (Phase 15): cross-run dedup, 15-day reset, no-key passthrough
 * - Phase 5.1: isDuplicateLead is now async (concurrency-safe per-key mutex)
 */

import { store } from '../store';
import { RawLead } from '../types';
import {
  buildDedupKey,
  extractRootDomain,
  isDuplicateLead,
  clearRollingWindowForTesting,
  getRollingWindowSize,
} from './deduplicator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawLead> = {}): RawLead {
  return {
    name: 'Acme Corp',
    address: '123 Main St',
    rawPhone: '+12025551234',
    website: 'https://www.acme.com',
    placeId: 'place-001',
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  clearRollingWindowForTesting();
});

// ─── extractRootDomain ────────────────────────────────────────────────────────

describe('extractRootDomain()', () => {
  it('extracts root domain from a simple URL', () => {
    expect(extractRootDomain('https://www.example.com')).toBe('example.com');
  });

  it('strips subdomain', () => {
    expect(extractRootDomain('https://blog.example.com')).toBe('example.com');
  });

  it('handles multi-part TLD (.co.uk)', () => {
    expect(extractRootDomain('https://www.shop.example.co.uk')).toBe('example.co.uk');
  });

  it('handles multi-part TLD (.com.au)', () => {
    expect(extractRootDomain('https://store.example.com.au')).toBe('example.com.au');
  });

  it('adds https:// prefix when missing', () => {
    expect(extractRootDomain('www.example.com')).toBe('example.com');
  });

  it('returns empty string for empty input', () => {
    expect(extractRootDomain('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(extractRootDomain('   ')).toBe('');
  });

  it('handles URL without www', () => {
    expect(extractRootDomain('https://example.com/path')).toBe('example.com');
  });
});

// ─── buildDedupKey ────────────────────────────────────────────────────────────

describe('buildDedupKey()', () => {
  it('builds key as phone|domain', () => {
    expect(buildDedupKey('+12025551234', 'https://acme.com')).toBe('+12025551234|acme.com');
  });

  it('returns |domain when phone is empty', () => {
    expect(buildDedupKey('', 'https://acme.com')).toBe('|acme.com');
  });

  it('returns phone| when website is empty', () => {
    expect(buildDedupKey('+12025551234', '')).toBe('+12025551234|');
  });

  it('returns | when both are empty', () => {
    expect(buildDedupKey('', '')).toBe('|');
  });

  it('trims whitespace from phone', () => {
    expect(buildDedupKey('  +12025551234  ', 'https://acme.com')).toBe('+12025551234|acme.com');
  });
});

// ─── isDuplicateLead ──────────────────────────────────────────────────────────

describe('isDuplicateLead()', () => {
  it('returns false for a new lead and does not increment duplicate_skipped', async () => {
    const lead = makeRaw();
    expect(await isDuplicateLead(lead)).toBe(false);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(0);
  });

  it('returns true for a duplicate lead and increments duplicate_skipped', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead); // first — registers key
    expect(await isDuplicateLead(lead)).toBe(true); // second — duplicate
    expect(store.getFailureMetrics().duplicate_skipped).toBe(1);
  });

  it('treats leads with same phone but different domain as NOT duplicates', async () => {
    const lead1 = makeRaw({ website: 'https://acme.com' });
    const lead2 = makeRaw({ website: 'https://beta.com' });
    await isDuplicateLead(lead1);
    // Different domain, same phone — key differs, so NOT a duplicate
    expect(await isDuplicateLead(lead2)).toBe(false);
  });

  it('treats leads with same domain but different phone as NOT duplicates', async () => {
    const lead1 = makeRaw({ rawPhone: '+12025551234' });
    const lead2 = makeRaw({ rawPhone: '+12025559999' });
    await isDuplicateLead(lead1);
    expect(await isDuplicateLead(lead2)).toBe(false);
  });

  it('passes through leads with no phone AND no website (no key)', async () => {
    const lead = makeRaw({ rawPhone: '', website: '' });
    expect(await isDuplicateLead(lead)).toBe(false);
    expect(await isDuplicateLead(lead)).toBe(false);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(0);
  });

  it('dedup set is cleared on store.reset() but rolling window persists', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead);
    store.reset();
    // Per-run Set cleared, rolling window still has the key → duplicate
    expect(await isDuplicateLead(lead)).toBe(true);
  });

  it('lead is treated as new after rolling window is cleared', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead);
    store.reset();
    clearRollingWindowForTesting();
    expect(await isDuplicateLead(lead)).toBe(false);
  });

  it('correctly handles multi-part TLD in website URL', async () => {
    const lead1 = makeRaw({ website: 'https://www.shop.example.co.uk' });
    const lead2 = makeRaw({ website: 'https://blog.example.co.uk' });
    await isDuplicateLead(lead1); // key: +12025551234|example.co.uk
    expect(await isDuplicateLead(lead2)).toBe(true);
  });
});

// ─── Rolling Window (Phase 15) ────────────────────────────────────────────────

describe('Rolling window (Phase 15)', () => {
  it('getRollingWindowSize() returns 0 on a fresh start', () => {
    expect(getRollingWindowSize()).toBe(0);
  });

  it('registers a new lead in the rolling window', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead);
    expect(getRollingWindowSize()).toBe(1);
  });

  it('catches duplicate across simulated job runs (rolling window survives store.reset)', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead);
    store.reset(); // clears per-run Set

    expect(await isDuplicateLead(lead)).toBe(true);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(1);
  });

  it('does not double-count duplicate_skipped when rolling window catches it', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead); // first — new
    await isDuplicateLead(lead); // second — duplicate
    expect(store.getFailureMetrics().duplicate_skipped).toBe(1);
  });

  it('treats lead as new after rolling window is cleared (simulates 15-day reset)', async () => {
    const lead = makeRaw();
    await isDuplicateLead(lead);
    store.reset();
    clearRollingWindowForTesting();

    expect(await isDuplicateLead(lead)).toBe(false);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(0);
  });

  it('no-key leads are never added to the rolling window', async () => {
    const lead = makeRaw({ rawPhone: '', website: '' });
    await isDuplicateLead(lead);
    await isDuplicateLead(lead);
    expect(getRollingWindowSize()).toBe(0);
  });
});

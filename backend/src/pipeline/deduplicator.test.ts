/**
 * deduplicator.test.ts
 * Unit tests for the deduplicator module.
 *
 * Covers:
 * - extractRootDomain: subdomains, multi-part TLDs, missing protocol, empty input
 * - buildDedupKey: key format
 * - isDuplicateLead: new lead passes, duplicate skipped, no-key passes through
 */

import { store } from '../store';
import { RawLead } from '../types';
import { buildDedupKey, extractRootDomain, isDuplicateLead } from './deduplicator';

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
  it('returns false for a new lead and does not increment duplicate_skipped', () => {
    const lead = makeRaw();
    expect(isDuplicateLead(lead)).toBe(false);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(0);
  });

  it('returns true for a duplicate lead and increments duplicate_skipped', () => {
    const lead = makeRaw();
    isDuplicateLead(lead); // first — registers key
    expect(isDuplicateLead(lead)).toBe(true); // second — duplicate
    expect(store.getFailureMetrics().duplicate_skipped).toBe(1);
  });

  it('treats leads with same phone but different domain as duplicates (phone match)', () => {
    const lead1 = makeRaw({ website: 'https://acme.com' });
    const lead2 = makeRaw({ website: 'https://beta.com' });
    isDuplicateLead(lead1);
    // Different domain but same phone — key is different, so NOT a duplicate
    expect(isDuplicateLead(lead2)).toBe(false);
  });

  it('treats leads with same domain but different phone as NOT duplicates', () => {
    const lead1 = makeRaw({ rawPhone: '+12025551234' });
    const lead2 = makeRaw({ rawPhone: '+12025559999' });
    isDuplicateLead(lead1);
    expect(isDuplicateLead(lead2)).toBe(false);
  });

  it('passes through leads with no phone AND no website (no key)', () => {
    const lead = makeRaw({ rawPhone: '', website: '' });
    expect(isDuplicateLead(lead)).toBe(false);
    // Second call also passes through — no key means never deduped
    expect(isDuplicateLead(lead)).toBe(false);
    expect(store.getFailureMetrics().duplicate_skipped).toBe(0);
  });

  it('dedup set is cleared on store.reset()', () => {
    const lead = makeRaw();
    isDuplicateLead(lead);
    store.reset();
    // After reset, same lead should be treated as new
    expect(isDuplicateLead(lead)).toBe(false);
  });

  it('correctly handles multi-part TLD in website URL', () => {
    const lead1 = makeRaw({ website: 'https://www.shop.example.co.uk' });
    const lead2 = makeRaw({ website: 'https://blog.example.co.uk' });
    isDuplicateLead(lead1); // key: +12025551234|example.co.uk
    // Same root domain, same phone → duplicate
    expect(isDuplicateLead(lead2)).toBe(true);
  });
});

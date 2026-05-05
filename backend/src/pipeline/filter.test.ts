/**
 * filter.test.ts
 * Unit tests for the post-scrape filter and quality tier assignment.
 *
 * Covers:
 * - assignQualityTier: Tier1/Tier2/Tier3 assignment
 * - processLead: lead with email+phone → accepted, Tier1, _hasBoth=true
 * - processLead: lead with email only → accepted, Tier2, _hasBoth=false
 * - processLead: lead with phone only → accepted, Tier3, _hasBoth=false
 * - processLead: lead with neither → discarded, discard_no_contact++, SSE discard emitted
 * - processLead: SSE lead event carries public fields only (no _hasBoth, no _qualityTier)
 * - processLead: SSE discard event carries updated stats
 * - processLead: discarded lead NOT added to store.leads[]
 * - processLead: accepted lead IS added to store.leads[]
 */

import { store } from '../store';
import { assignQualityTier, processLead, ExtractedLead } from './filter';
import { RawLead } from '../types';

// ─── Mock SSE ─────────────────────────────────────────────────────────────────

jest.mock('../sse', () => ({
  emitLead: jest.fn(),
  emitDiscard: jest.fn(),
}));

import { emitLead, emitDiscard } from '../sse';
const mockEmitLead = emitLead as jest.MockedFunction<typeof emitLead>;
const mockEmitDiscard = emitDiscard as jest.MockedFunction<typeof emitDiscard>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const JOB_ID = 'test-job-001';

function makeRaw(overrides: Partial<RawLead> = {}): RawLead {
  return {
    name: 'Acme Corp',
    address: '123 Main St, London, UK',
    rawPhone: '+12025551234',
    website: 'https://acme.com',
    placeId: 'place-001',
    ...overrides,
  };
}

function makeLead(
  email: string,
  phone: string,
  rawOverrides: Partial<RawLead> = {}
): ExtractedLead {
  return { raw: makeRaw(rawOverrides), email, phone };
}

beforeEach(() => {
  store.reset();
  mockEmitLead.mockClear();
  mockEmitDiscard.mockClear();
});

// ─── assignQualityTier ────────────────────────────────────────────────────────

describe('assignQualityTier()', () => {
  it('returns Tier1 when both email and phone are present', () => {
    expect(assignQualityTier('info@acme.com', '+12025551234')).toBe('Tier1');
  });

  it('returns Tier2 when only email is present', () => {
    expect(assignQualityTier('info@acme.com', '')).toBe('Tier2');
  });

  it('returns Tier3 when only phone is present', () => {
    expect(assignQualityTier('', '+12025551234')).toBe('Tier3');
  });
});

// ─── processLead — accepted paths ────────────────────────────────────────────

describe('processLead() — Tier1 (email + phone)', () => {
  it('returns true', () => {
    const result = processLead(JOB_ID, makeLead('info@acme.com', '+12025551234'));
    expect(result).toBe(true);
  });

  it('adds lead to store with correct fields', () => {
    processLead(JOB_ID, makeLead('info@acme.com', '+12025551234'));
    const leads = store.getLeads();
    expect(leads).toHaveLength(1);
    expect(leads[0].businessName).toBe('Acme Corp');
    expect(leads[0].email).toBe('info@acme.com');
    expect(leads[0].phone).toBe('+12025551234');
    expect(leads[0]._hasBoth).toBe(true);
    expect(leads[0]._qualityTier).toBe('Tier1');
  });

  it('emits SSE lead event with public fields only', () => {
    processLead(JOB_ID, makeLead('info@acme.com', '+12025551234'));
    expect(mockEmitLead).toHaveBeenCalledTimes(1);
    const payload = mockEmitLead.mock.calls[0][1];
    expect(payload.businessName).toBe('Acme Corp');
    expect(payload.email).toBe('info@acme.com');
    expect(payload.phone).toBe('+12025551234');
    // Internal fields must NOT be in SSE payload
    expect((payload as Record<string, unknown>)['_hasBoth']).toBeUndefined();
    expect((payload as Record<string, unknown>)['_qualityTier']).toBeUndefined();
  });

  it('does NOT emit discard event', () => {
    processLead(JOB_ID, makeLead('info@acme.com', '+12025551234'));
    expect(mockEmitDiscard).not.toHaveBeenCalled();
  });
});

describe('processLead() — Tier2 (email only)', () => {
  it('returns true', () => {
    expect(processLead(JOB_ID, makeLead('info@acme.com', ''))).toBe(true);
  });

  it('sets _hasBoth=false and _qualityTier=Tier2', () => {
    processLead(JOB_ID, makeLead('info@acme.com', ''));
    const lead = store.getLeads()[0];
    expect(lead._hasBoth).toBe(false);
    expect(lead._qualityTier).toBe('Tier2');
  });

  it('stores empty string for phone (not null/undefined)', () => {
    processLead(JOB_ID, makeLead('info@acme.com', ''));
    expect(store.getLeads()[0].phone).toBe('');
  });
});

describe('processLead() — Tier3 (phone only)', () => {
  it('returns true', () => {
    expect(processLead(JOB_ID, makeLead('', '+12025551234'))).toBe(true);
  });

  it('sets _hasBoth=false and _qualityTier=Tier3', () => {
    processLead(JOB_ID, makeLead('', '+12025551234'));
    const lead = store.getLeads()[0];
    expect(lead._hasBoth).toBe(false);
    expect(lead._qualityTier).toBe('Tier3');
  });

  it('stores empty string for email (not null/undefined)', () => {
    processLead(JOB_ID, makeLead('', '+12025551234'));
    expect(store.getLeads()[0].email).toBe('');
  });
});

// ─── processLead — discard path ───────────────────────────────────────────────

describe('processLead() — discard (no email, no phone)', () => {
  it('returns false', () => {
    expect(processLead(JOB_ID, makeLead('', ''))).toBe(false);
  });

  it('does NOT add lead to store', () => {
    processLead(JOB_ID, makeLead('', ''));
    expect(store.getLeads()).toHaveLength(0);
  });

  it('increments discard count', () => {
    processLead(JOB_ID, makeLead('', ''));
    expect(store.getStats().discardCount).toBe(1);
  });

  it('increments discard_no_contact metric', () => {
    processLead(JOB_ID, makeLead('', ''));
    expect(store.getFailureMetrics().discard_no_contact).toBe(1);
  });

  it('emits SSE discard event with updated stats', () => {
    processLead(JOB_ID, makeLead('', ''));
    expect(mockEmitDiscard).toHaveBeenCalledTimes(1);
    const payload = mockEmitDiscard.mock.calls[0][1];
    expect(payload.total).toBe(1);
    expect(payload.leadCount).toBe(0);
  });

  it('does NOT emit SSE lead event', () => {
    processLead(JOB_ID, makeLead('', ''));
    expect(mockEmitLead).not.toHaveBeenCalled();
  });

  it('increments discard count for each discarded lead', () => {
    processLead(JOB_ID, makeLead('', ''));
    processLead(JOB_ID, makeLead('', ''));
    processLead(JOB_ID, makeLead('', ''));
    expect(store.getStats().discardCount).toBe(3);
    expect(store.getFailureMetrics().discard_no_contact).toBe(3);
  });
});

// ─── Mixed batch ─────────────────────────────────────────────────────────────

describe('processLead() — mixed batch', () => {
  it('correctly separates accepted and discarded leads', () => {
    processLead(JOB_ID, makeLead('a@acme.com', '+12025551234'));  // Tier1
    processLead(JOB_ID, makeLead('b@acme.com', ''));              // Tier2
    processLead(JOB_ID, makeLead('', '+12025559999'));            // Tier3
    processLead(JOB_ID, makeLead('', ''));                        // discard

    expect(store.getLeads()).toHaveLength(3);
    expect(store.getStats().discardCount).toBe(1);
    expect(store.getFailureMetrics().discard_no_contact).toBe(1);
    expect(mockEmitLead).toHaveBeenCalledTimes(3);
    expect(mockEmitDiscard).toHaveBeenCalledTimes(1);
  });

  it('lead address and website are correctly mapped from raw', () => {
    processLead(
      JOB_ID,
      makeLead('info@acme.com', '+12025551234', {
        address: '456 Oak Ave, New York',
        website: 'https://acme.com',
      })
    );
    const lead = store.getLeads()[0];
    expect(lead.address).toBe('456 Oak Ave, New York');
    expect(lead.website).toBe('https://acme.com');
  });
});

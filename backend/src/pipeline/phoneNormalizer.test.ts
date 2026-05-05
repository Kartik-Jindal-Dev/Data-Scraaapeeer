/**
 * phoneNormalizer.test.ts
 * Unit tests for phone extraction and normalisation.
 *
 * Covers:
 * - normalisePhone: valid US, UK, Indian numbers → E.164
 * - normalisePhone: already-E.164 input passes through
 * - normalisePhone: invalid string returns empty
 * - normalisePhone: empty input returns empty
 * - extractPhone: discovery phone takes priority over page phone
 * - extractPhone: falls back to page phone when discovery phone absent/invalid
 * - extractPhone: extracts from page text via regex patterns
 * - extractPhone: phone_not_found metric incremented when nothing found
 * - extractPhone: strips HTML tags before scanning
 */

import { store } from '../store';
import { extractPhone, normalisePhone } from './phoneNormalizer';

beforeEach(() => {
  store.reset();
});

// ─── normalisePhone ───────────────────────────────────────────────────────────

describe('normalisePhone()', () => {
  it('normalises a US number with defaultRegion US', () => {
    expect(normalisePhone('(202) 555-1234', 'US')).toBe('+12025551234');
  });

  it('normalises a UK number with defaultRegion GB', () => {
    expect(normalisePhone('020 7946 0958', 'GB')).toBe('+442079460958');
  });

  it('normalises an Indian number with defaultRegion IN', () => {
    expect(normalisePhone('098765 43210', 'IN')).toBe('+919876543210');
  });

  it('passes through an already-E.164 number', () => {
    expect(normalisePhone('+12025551234', 'US')).toBe('+12025551234');
  });

  it('returns empty string for an unparseable string', () => {
    expect(normalisePhone('not-a-phone', 'US')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(normalisePhone('', 'US')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalisePhone('   ', 'US')).toBe('');
  });

  it('handles country code already present in number', () => {
    expect(normalisePhone('+44 20 7946 0958', 'US')).toBe('+442079460958');
  });

  it('uses US as fallback when isoCode is empty', () => {
    // +1 number should still parse with empty isoCode (falls back to US)
    const result = normalisePhone('+12025551234', '');
    expect(result).toBe('+12025551234');
  });
});

// ─── extractPhone ─────────────────────────────────────────────────────────────

describe('extractPhone() — discovery phone priority', () => {
  it('uses discovery phone when valid', () => {
    const result = extractPhone('+12025551234', '', 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
    expect(store.getFailureMetrics().phone_not_found).toBe(0);
  });

  it('normalises discovery phone to E.164', () => {
    const result = extractPhone('(202) 555-1234', '', 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
  });

  it('falls back to page when discovery phone is invalid', () => {
    const html = '<html><body><p>Call us: +44 20 7946 0958</p></body></html>';
    const result = extractPhone('not-a-phone', html, 'GB', 'UK Biz');
    expect(result).toBe('+442079460958');
  });

  it('falls back to page when discovery phone is empty', () => {
    const html = '<html><body><p>Phone: (202) 555-1234</p></body></html>';
    const result = extractPhone('', html, 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
  });
});

describe('extractPhone() — page text extraction', () => {
  it('extracts international format phone from page text', () => {
    const html = '<html><body><p>Contact: +1 (202) 555-1234</p></body></html>';
    const result = extractPhone('', html, 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
  });

  it('extracts US format phone from page text', () => {
    const html = '<html><body><p>Call (202) 555-1234 today</p></body></html>';
    const result = extractPhone('', html, 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
  });

  it('strips HTML tags before scanning', () => {
    const html = '<html><body><span class="phone">+44 20 7946 0958</span></body></html>';
    const result = extractPhone('', html, 'GB', 'UK Biz');
    expect(result).toBe('+442079460958');
  });

  it('ignores script tag content', () => {
    const html = `<html><body>
      <script>var phone = "555-0000";</script>
      <p>Real phone: +12025551234</p>
    </body></html>`;
    const result = extractPhone('', html, 'US', 'Acme Corp');
    expect(result).toBe('+12025551234');
  });
});

describe('extractPhone() — phone_not_found metric', () => {
  it('increments phone_not_found when no phone found anywhere', () => {
    extractPhone('', '<html><body>No phone here</body></html>', 'US', 'Acme Corp');
    expect(store.getFailureMetrics().phone_not_found).toBe(1);
  });

  it('increments phone_not_found when both discovery and page are empty', () => {
    extractPhone('', '', 'US', 'Acme Corp');
    expect(store.getFailureMetrics().phone_not_found).toBe(1);
  });

  it('does NOT increment when discovery phone is valid', () => {
    extractPhone('+12025551234', '', 'US', 'Acme Corp');
    expect(store.getFailureMetrics().phone_not_found).toBe(0);
  });

  it('does NOT increment when page phone is found', () => {
    extractPhone('', '<html><body>+12025551234</body></html>', 'US', 'Acme Corp');
    expect(store.getFailureMetrics().phone_not_found).toBe(0);
  });
});

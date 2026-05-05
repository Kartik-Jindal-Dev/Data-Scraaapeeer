/**
 * geocoder.test.ts
 * Unit tests for the Nominatim geocoder.
 *
 * Tests cleanLocationQuery() and the fetch logic via mocked global fetch.
 * Does NOT make real network calls.
 */

import { cleanLocationQuery, geocodeLocation } from './geocoder';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockNominatimSuccess(countryCode: string, displayName = 'Test City, Test Country') {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [
      {
        display_name: displayName,
        address: { country_code: countryCode },
      },
    ],
  });
}

function mockNominatimEmpty() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [],
  });
}

function mockNominatimHttpError(status = 500) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
  });
}

function mockNominatimNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
});

describe('cleanLocationQuery()', () => {
  it('trims leading and trailing whitespace', () => {
    expect(cleanLocationQuery('  London  ')).toBe('London');
  });

  it('collapses multiple spaces', () => {
    expect(cleanLocationQuery('New   York   City')).toBe('New York City');
  });

  it('removes special characters except comma, dot, hyphen', () => {
    expect(cleanLocationQuery('London, UK!')).toBe('London, UK');
    expect(cleanLocationQuery('São Paulo')).toBe('So Paulo'); // non-ASCII removed
  });

  it('preserves commas, dots, and hyphens', () => {
    expect(cleanLocationQuery('St. Louis, MO')).toBe('St. Louis, MO');
    expect(cleanLocationQuery('Île-de-France')).toBe('le-de-France');
  });

  it('handles empty string', () => {
    expect(cleanLocationQuery('')).toBe('');
  });
});

describe('geocodeLocation()', () => {
  it('throws for empty location string', async () => {
    await expect(geocodeLocation('')).rejects.toThrow('Location string is empty');
  });

  it('throws for whitespace-only location string', async () => {
    await expect(geocodeLocation('   ')).rejects.toThrow('Location string is empty');
  });

  it('returns ISO country code on success', async () => {
    mockNominatimSuccess('gb', 'London, England, United Kingdom');
    const result = await geocodeLocation('London, UK');
    expect(result.isoCountryCode).toBe('GB'); // uppercased
    expect(result.displayName).toBe('London, England, United Kingdom');
  });

  it('returns empty isoCountryCode when address is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ display_name: 'Somewhere', address: {} }],
    });
    const result = await geocodeLocation('Somewhere');
    expect(result.isoCountryCode).toBe('');
  });

  it('retries with cleaned query when first attempt returns empty results', async () => {
    // First call: empty results
    mockNominatimEmpty();
    // Second call (retry with cleaned query): success
    mockNominatimSuccess('in', 'Noida, Uttar Pradesh, India');

    const result = await geocodeLocation('  Noida, India!  ');
    expect(result.isoCountryCode).toBe('IN');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after both attempts fail', async () => {
    mockNominatimEmpty();
    mockNominatimEmpty();
    await expect(geocodeLocation('asdfasdf')).rejects.toThrow(
      'could not be resolved'
    );
  });

  it('retries after HTTP error on first attempt', async () => {
    // Use a location with special chars so cleaned !== original, triggering retry
    mockNominatimHttpError(503);
    mockNominatimSuccess('us', 'New York, USA');
    const result = await geocodeLocation('New York!!');
    expect(result.isoCountryCode).toBe('US');
  });

  it('retries after network error on first attempt', async () => {
    // Use a location with extra whitespace so cleaned !== original, triggering retry
    mockNominatimNetworkError();
    mockNominatimSuccess('fr', 'Paris, France');
    const result = await geocodeLocation('  Paris  ');
    expect(result.isoCountryCode).toBe('FR');
  });

  it('does not retry if cleaned query equals original query', async () => {
    // "London" is already clean — no retry should happen
    mockNominatimEmpty();
    await expect(geocodeLocation('London')).rejects.toThrow('could not be resolved');
    // Only one fetch call — no retry because cleaned === original
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

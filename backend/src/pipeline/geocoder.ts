/**
 * pipeline/geocoder.ts
 * Location validation using OpenStreetMap Nominatim (free, no API key required).
 *
 * FREE STACK: No Google Geocoding API. No paid services.
 * Source: https://nominatim.openstreetmap.org/search
 *
 * Behaviour:
 * - Sends a GET request to Nominatim with the location string.
 * - On success: returns the ISO 3166-1 alpha-2 country code from the response.
 * - On first failure: retries once with a cleaned/normalised query.
 * - On second failure: throws — caller returns 422 to the client.
 *
 * Nominatim usage policy:
 * - Max 1 request/second. We add a 1.1s delay between retries.
 * - User-Agent header is required and set to identify this application.
 * - No bulk geocoding — one call per job start is well within limits.
 */

import { logger } from '../logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeocodeResult {
  /** ISO 3166-1 alpha-2 country code, e.g. "IN", "US", "GB". May be empty string. */
  isoCountryCode: string;
  /** Display name returned by Nominatim for logging/debug. */
  displayName: string;
}

// ─── Nominatim Response Shape (partial) ──────────────────────────────────────

interface NominatimResult {
  display_name: string;
  address?: {
    country_code?: string;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'LeadGenerationScraper/2.0 (in-house tool; contact: admin@localhost)';
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 1_100; // Nominatim rate limit: 1 req/s

// ─── Query Cleaner ────────────────────────────────────────────────────────────

/**
 * Normalises a location query for retry:
 * - Trims whitespace
 * - Collapses multiple spaces
 * - Removes characters that are not alphanumeric, spaces, commas, hyphens, or dots
 */
export function cleanLocationQuery(query: string): string {
  return query
    .trim()
    .replace(/[^\w\s,.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Nominatim Fetch ──────────────────────────────────────────────────────────

async function fetchNominatim(query: string): Promise<GeocodeResult | null> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '1');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en',
      },
    });

    clearTimeout(timer);

    if (!res.ok) {
      logger.warn(`Nominatim HTTP ${res.status} for query: "${query}"`);
      return null;
    }

    const data = (await res.json()) as NominatimResult[];

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    const first = data[0];
    const rawCode = first.address?.country_code ?? '';
    const isoCountryCode = rawCode.toUpperCase(); // Nominatim returns lowercase

    return {
      isoCountryCode,
      displayName: first.display_name,
    };
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      logger.warn(`Nominatim timeout for query: "${query}"`);
    } else {
      logger.warn(`Nominatim fetch error: ${(err as Error).message}`);
    }
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates a location string using Nominatim.
 * Retries once with a cleaned query if the first attempt fails.
 *
 * Returns a GeocodeResult on success.
 * Throws an Error with a user-facing message if both attempts fail.
 */
export async function geocodeLocation(location: string): Promise<GeocodeResult> {
  if (!location || location.trim().length === 0) {
    throw new Error('Location string is empty');
  }

  // First attempt: original query
  logger.info(`Geocoding location: "${location}"`);
  const result = await fetchNominatim(location);

  if (result) {
    logger.info(
      `Geocoded "${location}" → "${result.displayName}" (ISO: ${result.isoCountryCode || 'unknown'})`
    );
    return result;
  }

  // Retry with cleaned query
  const cleaned = cleanLocationQuery(location);
  if (cleaned !== location && cleaned.length > 0) {
    logger.info(`Geocode retry with cleaned query: "${cleaned}"`);

    // Respect Nominatim rate limit between requests
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));

    const retryResult = await fetchNominatim(cleaned);
    if (retryResult) {
      logger.info(
        `Geocoded (retry) "${cleaned}" → "${retryResult.displayName}" (ISO: ${retryResult.isoCountryCode || 'unknown'})`
      );
      return retryResult;
    }
  }

  throw new Error(
    `Location "${location}" could not be resolved. Please check the spelling and try again.`
  );
}

/**
 * pipeline/phoneNormalizer.ts
 * Phone number extraction and normalisation to E.164 format.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §4):
 * - Every stored phone must be in E.164 format (+<country_code><number>).
 * - Normalisation uses libphonenumber-js with the ISO country code from Phase 2
 *   (Nominatim geocoder) as defaultRegion.
 * - A phone that libphonenumber-js cannot validate is discarded (empty string).
 * - Raw, unformatted phone strings must never appear in leads[].
 * - Increments phone_not_found metric when no valid phone is found.
 *
 * Priority:
 * 1. Discovery-phase phone (rawPhone from Google Maps) — normalised first.
 * 2. Website-scraped phone — used only if discovery phone is absent or invalid.
 */

import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';
import { logger } from '../logger';
import { store } from '../store';
import * as cheerio from 'cheerio';
import { extractFromJsonLd, truncateHtmlIfNeeded } from './emailExtractor';

// ─── Phone Regex Patterns ─────────────────────────────────────────────────────

/**
 * Ordered list of regex patterns for extracting phone candidates from text.
 * Applied in order; first valid E.164 result wins.
 */
const PHONE_PATTERNS: RegExp[] = [
  /\+[\d\s\-().]{7,20}/g,                        // international format: +1 (202) 555-1234
  /\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/g,      // US/CA format: (202) 555-1234
  /\d{8,15}/g,                                    // bare digit strings
];

// ─── Normalise a Single Phone String ─────────────────────────────────────────

/**
 * Attempts to parse and normalise a raw phone string to E.164.
 * Returns the E.164 string on success, or empty string on failure.
 *
 * @param raw       - Raw phone string (may include spaces, dashes, parens)
 * @param isoCode   - ISO 3166-1 alpha-2 country code used as defaultRegion
 */
export function normalisePhone(raw: string, isoCode: string): string {
  if (!raw || raw.trim().length === 0) return '';

  const region = (isoCode || 'US').toUpperCase() as CountryCode;

  try {
    const parsed = parsePhoneNumberFromString(raw.trim(), region);
    if (parsed?.isValid()) {
      return parsed.format('E.164');
    }
  } catch {
    // libphonenumber-js throws on completely unparseable input
  }

  return '';
}

// ─── Extract Phone from Page Text ────────────────────────────────────────────

/**
 * Scans page text for phone number candidates and returns the first valid E.164.
 *
 * @param text    - Visible text content of the page
 * @param isoCode - ISO country code for defaultRegion
 */
function extractPhoneFromText(text: string, isoCode: string): string {
  if (!text || text.trim().length === 0) return '';

  for (const pattern of PHONE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];

    for (const match of matches) {
      const candidate = match[0].trim();
      const normalised = normalisePhone(candidate, isoCode);
      if (normalised) return normalised;
    }
  }

  return '';
}

// ─── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Extracts and normalises a phone number for a lead.
 *
 * Priority:
 * 1. rawPhone from discovery (Google Maps) — normalised to E.164.
 * 2. Phone extracted from page HTML text — used if discovery phone is absent/invalid.
 *
 * @param rawDiscoveryPhone - Raw phone string from Google Maps discovery
 * @param pageHtml          - Full HTML of the scraped page (may be empty)
 * @param isoCode           - ISO 3166-1 alpha-2 country code from Nominatim geocoder
 * @param businessName      - Used for logging only
 * @param parsed$           - Optional pre-parsed Cheerio instance (avoids re-parsing)
 * @returns                 - E.164 phone string, or empty string if none found
 *
 * Side effects:
 * - Increments store.failureMetrics.phone_not_found when no valid phone is found
 */
export function extractPhone(
  rawDiscoveryPhone: string,
  pageHtml: string,
  isoCode: string,
  businessName: string,
  parsed$?: ReturnType<typeof cheerio.load>
): string {
  // ── Priority 1: discovery phone ───────────────────────────────────────────
  if (rawDiscoveryPhone && rawDiscoveryPhone.trim().length > 0) {
    const normalised = normalisePhone(rawDiscoveryPhone, isoCode);
    if (normalised) {
      logger.info(`PhoneNormalizer: discovery phone "${normalised}" for "${businessName}"`);
      return normalised;
    }
    logger.info(
      `PhoneNormalizer: discovery phone "${rawDiscoveryPhone}" invalid for "${businessName}" — trying page`
    );
  }

  // ── Priority 1.5: JSON-LD structured data ────────────────────────────────
  if (pageHtml && pageHtml.trim().length > 0) {
    // Phase 5.5: truncate oversized HTML before parsing
    const safeHtml = truncateHtmlIfNeeded(pageHtml);
    const jsonLdData = extractFromJsonLd(safeHtml, parsed$);
    if (jsonLdData.phone) {
      const normalised = normalisePhone(jsonLdData.phone, isoCode);
      if (normalised) {
        logger.info(`PhoneNormalizer: JSON-LD phone "${normalised}" for "${businessName}"`);
        return normalised;
      }
    }
  }

  // ── Priority 2: website page text ─────────────────────────────────────────
  if (pageHtml && pageHtml.trim().length > 0) {
    // Phase 5.5: truncate oversized HTML before text extraction
    const safeHtml = truncateHtmlIfNeeded(pageHtml);
    // Strip HTML tags to get visible text for phone regex scanning
    const textContent = safeHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const fromPage = extractPhoneFromText(textContent, isoCode);
    if (fromPage) {
      logger.info(`PhoneNormalizer: page phone "${fromPage}" for "${businessName}"`);
      return fromPage;
    }
  }

  // ── No valid phone found ──────────────────────────────────────────────────
  logger.info(`PhoneNormalizer: no valid phone found for "${businessName}"`);
  store.incrementMetric('phone_not_found');
  return '';
}

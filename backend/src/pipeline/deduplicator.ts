/**
 * pipeline/deduplicator.ts
 * In-memory deduplication for raw leads within a single job run.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §7):
 * - Dedup key format: `${normalizedPhone}|${rootDomain}`
 * - rootDomain extracted via `tldts` — handles subdomains + multi-part TLDs (.co.uk, .com.au)
 * - If both normalizedPhone and rootDomain are empty → entry passes through (no key)
 * - The dedup Set is owned by the store and cleared on store.reset()
 *
 * This module builds the dedup key and delegates the Set check to store.isDuplicate().
 */

import { parse as parseTld } from 'tldts';
import { logger } from '../logger';
import { store } from '../store';
import { RawLead } from '../types';

// ─── Root Domain Extraction ───────────────────────────────────────────────────

/**
 * Extracts the registrable root domain from a URL string using tldts.
 * Correctly handles:
 * - Subdomains: www.shop.example.com → example.com
 * - Multi-part TLDs: www.shop.example.co.uk → example.co.uk
 * - Missing protocol: adds https:// prefix before parsing
 *
 * Returns empty string if the URL is empty or unparseable.
 */
export function extractRootDomain(url: string): string {
  if (!url || url.trim().length === 0) return '';

  try {
    // Ensure the URL has a protocol so tldts can parse it
    const normalised = url.startsWith('http') ? url : `https://${url}`;
    const parsed = parseTld(normalised);
    return parsed.domain ?? '';
  } catch {
    return '';
  }
}

// ─── Dedup Key Builder ────────────────────────────────────────────────────────

/**
 * Builds the dedup key for a raw lead.
 * Format: `${normalizedPhone}|${rootDomain}`
 *
 * normalizedPhone: the raw phone string as-is at this stage
 * (full E.164 normalisation happens in Phase 3 phoneNormalizer).
 * For dedup purposes, we use the raw phone trimmed of whitespace.
 *
 * rootDomain: extracted via tldts from the website URL.
 */
export function buildDedupKey(rawPhone: string, websiteUrl: string): string {
  const phone = (rawPhone ?? '').trim();
  const domain = extractRootDomain(websiteUrl);
  return `${phone}|${domain}`;
}

// ─── Main Dedup Function ──────────────────────────────────────────────────────

/**
 * Checks whether a RawLead is a duplicate of one already seen in this job run.
 *
 * Returns true if the lead should be skipped (duplicate).
 * Returns false if the lead is new and should proceed to scraping.
 *
 * Side effects on duplicate:
 * - Increments store.failureMetrics.duplicate_skipped
 * - Logs the skipped business name
 */
export function isDuplicateLead(lead: RawLead): boolean {
  const key = buildDedupKey(lead.rawPhone, lead.website);

  // No key can be formed — pass through without deduplication
  if (!key || key === '|') {
    return false;
  }

  if (store.isDuplicate(key)) {
    store.incrementMetric('duplicate_skipped');
    logger.info(`Dedup: skipped "${lead.name}" (key: ${key})`);
    return true;
  }

  return false;
}

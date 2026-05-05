/**
 * pipeline/filter.ts
 * Post-scrape filter, quality tier assignment, and lead finalisation.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §5):
 * - Filter runs ONLY after ALL scraping + extraction steps are complete.
 * - A lead is discarded ONLY if both email AND phone are empty after all steps.
 * - Discarding before all steps are complete is a bug.
 * - _hasBoth and _qualityTier are INTERNAL ONLY — never exported or in SSE payloads.
 *
 * On pass:  push to store.leads[], emit SSE `lead` event (PublicLead only)
 * On fail:  increment discard_no_contact, emit SSE `discard` event, log
 */

import { logger } from '../logger';
import { store } from '../store';
import { emitDiscard, emitLead } from '../sse';
import { Lead, QualityTier, RawLead } from '../types';
import { detectContactForm } from './emailExtractor';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Input shape from the extraction step. */
export interface ExtractedLead {
  raw: RawLead;
  email: string;   // empty string if not found
  phone: string;   // E.164 or empty string
  html?: string;   // page HTML for contact form detection
}

// ─── Quality Tier Assignment ──────────────────────────────────────────────────

/**
 * Assigns an internal quality tier based on contact completeness.
 *
 * Tier1 — both email AND phone present
 * Tier2 — email only
 * Tier3 — phone only
 *
 * Never called for leads with neither (those are discarded before this).
 */
export function assignQualityTier(email: string, phone: string): QualityTier {
  if (email && phone) return 'Tier1';
  if (email)          return 'Tier2';
  return 'Tier3';
}

// ─── Main Filter Function ─────────────────────────────────────────────────────

/**
 * Applies the post-scrape filter to a single extracted lead.
 *
 * If the lead has at least one contact method (email OR phone):
 *   - Builds the Lead object with quality tier and _hasBoth flag
 *   - Pushes to store.leads[]
 *   - Emits SSE `lead` event (public fields only — no _hasBoth, no _qualityTier)
 *   - Returns true (lead accepted)
 *
 * If the lead has neither email nor phone:
 *   - Increments discard_no_contact metric
 *   - Emits SSE `discard` event with updated stats
 *   - Logs the discard with business name and reason
 *   - Returns false (lead discarded)
 *
 * @param jobId   - Used for SSE event emission
 * @param lead    - Extracted lead with email and phone fields
 */
export function processLead(jobId: string, lead: ExtractedLead): boolean {
  const { raw, email, phone } = lead;
  // ── Filter: discard if no contact method ─────────────────────────────────
  if (!email && !phone) {
    store.incrementDiscard();
    store.incrementMetric('discard_no_contact');

    const stats = store.getStats();
    logger.info(
      `Filter: discarded "${raw.name}" — no email or phone found`
    );

    emitDiscard(jobId, {
      total: stats.discardCount,
      leadCount: stats.leadCount,
      jobStatus: stats.jobStatus,
    });

    return false;
  }

  // ── Quality tier assignment ───────────────────────────────────────────────
  const _qualityTier = assignQualityTier(email, phone);
  const _hasBoth = _qualityTier === 'Tier1';

  // ── Build Lead object ─────────────────────────────────────────────────────
  const qualifiedLead: Lead = {
    businessName: raw.name,
    email,
    phone,
    website: raw.website || '',
    address: raw.address,
    _hasBoth,
    _qualityTier,
    hasContactForm: !email ? detectContactForm(lead.html ?? '') : false,
  };

  // ── Push to store ─────────────────────────────────────────────────────────
  store.addLead(qualifiedLead);

  // ── Emit SSE lead event (public fields only) ──────────────────────────────
  emitLead(jobId, {
    businessName: qualifiedLead.businessName,
    email:        qualifiedLead.email,
    phone:        qualifiedLead.phone,
    website:      qualifiedLead.website,
    address:      qualifiedLead.address,
    hasContactForm: qualifiedLead.hasContactForm,
  });

  logger.info(
    `Filter: accepted "${raw.name}" — tier=${_qualityTier} ` +
    `email="${email || '(none)'}" phone="${phone || '(none)'}"`
  );

  return true;
}

/**
 * pipeline/filter.ts
 * Post-scrape filter, quality tier assignment, and lead finalisation.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md §5):
 * - Filter runs ONLY after ALL scraping + extraction steps are complete.
 * - A lead is discarded based on the contactFilter mode chosen by the operator.
 * - Discarding before all steps are complete is a bug.
 * - _hasBoth and _qualityTier are INTERNAL ONLY — never exported or in SSE payloads.
 *
 * Contact filter modes:
 *   any        — keep if email OR phone present (default)
 *   email_only — keep only if email is present
 *   phone_only — keep only if phone is present
 *   both       — keep only if BOTH email AND phone are present
 *
 * On pass:  push to store.leads[], emit SSE `lead` event (PublicLead only)
 * On fail:  increment discard_no_contact, emit SSE `discard` event, log
 */

import { logger } from '../logger';
import { store } from '../store';
import { emitDiscard, emitLead } from '../sse';
import { ContactFilter, Lead, QualityTier, RawLead } from '../types';
import { detectContactForm, classifyEmailBounceRisk } from './emailExtractor';

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
 */
export function assignQualityTier(email: string, phone: string): QualityTier {
  if (email && phone) return 'Tier1';
  if (email)          return 'Tier2';
  return 'Tier3';
}

// ─── Contact Filter Check ─────────────────────────────────────────────────────

/**
 * Returns true if the lead passes the operator-chosen contact filter.
 *
 * any        — email OR phone present
 * email_only — email must be present (phone optional)
 * phone_only — phone must be present (email optional)
 * both       — BOTH email AND phone must be present
 */
export function passesContactFilter(
  email: string,
  phone: string,
  mode: ContactFilter
): boolean {
  switch (mode) {
    case 'email_only': return !!email;
    case 'phone_only': return !!phone;
    case 'both':       return !!email && !!phone;
    case 'any':
    default:           return !!(email || phone);
  }
}

// ─── Discard Reason Helper ────────────────────────────────────────────────────

function discardReason(mode: ContactFilter): string {
  switch (mode) {
    case 'email_only': return 'no email found (email_only filter)';
    case 'phone_only': return 'no phone found (phone_only filter)';
    case 'both':       return 'missing email or phone (both filter)';
    default:           return 'no email or phone found';
  }
}

// ─── Main Filter Function ─────────────────────────────────────────────────────

/**
 * Applies the post-scrape filter to a single extracted lead.
 *
 * @param jobId          - Used for SSE event emission
 * @param lead           - Extracted lead with email and phone fields
 * @param contactFilter  - Filter mode from JobContext (defaults to 'any')
 */
export function processLead(
  jobId: string,
  lead: ExtractedLead,
  contactFilter: ContactFilter = 'any'
): boolean {
  const { raw, email, phone } = lead;

  // ── Filter: discard if lead doesn't meet the chosen contact requirement ────
  if (!passesContactFilter(email, phone, contactFilter)) {
    store.incrementDiscard();
    store.incrementMetric('discard_no_contact');

    const stats = store.getStats();
    logger.info(`Filter: discarded "${raw.name}" — ${discardReason(contactFilter)}`);

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

  // ── Bounce-risk classification ────────────────────────────────────────────
  // Derive the company root domain from the website URL for relay/alias checks.
  const { parse: parseTld } = require('tldts') as typeof import('tldts');
  const companyRootDomain = raw.website
    ? (parseTld(raw.website)?.domain ?? '')
    : '';
  const bounceClass = email
    ? classifyEmailBounceRisk(email, companyRootDomain)
    : { email: '', isGenericEmail: false, isFreeEmail: false, isRelayEmail: false };

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
    isGenericEmail: bounceClass.isGenericEmail || undefined,
    isFreeEmail:    bounceClass.isFreeEmail    || undefined,
    isRelayEmail:   bounceClass.isRelayEmail   || undefined,
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
    isGenericEmail: qualifiedLead.isGenericEmail,
    isFreeEmail:    qualifiedLead.isFreeEmail,
    isRelayEmail:   qualifiedLead.isRelayEmail,
  });

  logger.info(
    `Filter: accepted "${raw.name}" — tier=${_qualityTier} ` +
    `email="${email || '(none)'}" phone="${phone || '(none)'}" filter=${contactFilter}`
  );

  return true;
}

/**
 * pipeline/emailExtractor.ts
 * Email extraction from page HTML.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md):
 * - NEVER guess or generate emails from domain patterns.
 * - Only emails literally present in the page HTML are used.
 * - Returns a single best email or empty string.
 * - Increments email_not_found metric when no email survives filtering.
 *
 * Extraction pipeline:
 * 0. JSON-LD structured data extraction (highest confidence)
 * 1. Collect from <a href="mailto:..."> elements (high confidence)
 * 2. Collect from regex scan of visible body text
 * 3. Deduplicate (case-insensitive)
 * 4. Apply extended blacklist filter
 * 5. Remove script/analytics noise + long local parts
 * 5.5 MX record validation (async)
 * 6. Rank: company-domain match > non-freemail > freemail fallback
 * 7. Return single best candidate
 */

import * as cheerio from 'cheerio';
import { parse as parseTld } from 'tldts';
import { promises as dns } from 'dns';
import { logger } from '../logger';
import { store } from '../store';

// ─── Phase 5.5: Memory-Optimized HTML Processing ─────────────────────────────

/**
 * Maximum HTML size to process in full. Documents larger than this are
 * truncated before Cheerio parsing to avoid holding multi-MB strings in memory.
 *
 * Most business websites are well under 500KB. Very large pages (>1MB) are
 * typically CMS-heavy sites where contact info is in the first portion anyway.
 *
 * Configurable via HTML_MAX_BYTES env var (default: 512KB).
 */
const HTML_MAX_BYTES = parseInt(process.env.HTML_MAX_BYTES ?? String(512 * 1024), 10);

/**
 * Truncates HTML to HTML_MAX_BYTES if it exceeds the limit.
 * Truncation is done at a safe boundary (last '<' before the limit) to avoid
 * cutting mid-tag and producing malformed HTML that confuses Cheerio.
 *
 * Returns the original string if within limit (no copy made).
 */
export function truncateHtmlIfNeeded(html: string): string {
  if (!html || html.length <= HTML_MAX_BYTES) return html;

  // Find the last tag boundary before the limit to avoid mid-tag truncation
  const cutoff = html.lastIndexOf('<', HTML_MAX_BYTES);
  const truncated = cutoff > 0 ? html.slice(0, cutoff) : html.slice(0, HTML_MAX_BYTES);

  return truncated;
}

// ─── MX Cache ─────────────────────────────────────────────────────────────────

/** Cache of domain → MX record validity to avoid repeated DNS lookups. */
const mxCache = new Map<string, boolean>();

// ─── Bounce-Risk: Hard Discard Lists ─────────────────────────────────────────

/**
 * Disposable / temporary email domains.
 * Emails from these domains are hard-discarded (email set to empty string).
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'tempmail.com',
  'yopmail.com',
  'throwam.com',
  'sharklasers.com',
  'guerrillamailblock.com',
  'grr.la',
  'spam4.me',
  'trashmail.com',
  'trashmail.me',
  'dispostable.com',
  'fakeinbox.com',
  'mailnull.com',
  'spamgourmet.com',
  'maildrop.cc',
]);

/**
 * Email relay / transactional platform domains.
 * Emails from these domains are hard-discarded — they are infrastructure addresses,
 * not real business contacts.
 */
const RELAY_DOMAINS = new Set([
  'tenantturnermail.com',
  'sendgrid.net',
  'amazonses.com',
  'mailgun.org',
  'mandrillapp.com',
  'sparkpostmail.com',
  'mailchimp.com',
  'constantcontact.com',
  'klaviyo.com',
  'sendinblue.com',
  'postmarkapp.com',
  'mailjet.com',
  'smtp2go.com',
  'elasticemail.com',
]);

/**
 * Local-part prefixes that indicate a system/role address with high bounce risk.
 * These are hard-discarded.
 */
const HARD_DISCARD_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'unsubscribe',
  'abuse',
  'spam',
  'help',
  'enquiries',
  'enquiries',
  'enquiry',
  'billing',
  'accounts',
  'reception',
  'mail',
  'email',
  'general',
  'service',
  'services',
]);

// ─── Bounce-Risk: Flag Lists ──────────────────────────────────────────────────

/**
 * Generic role-address local parts — flagged as isGenericEmail but NOT discarded.
 * These are legitimate business contacts, just lower-priority than personal emails.
 */
const GENERIC_LOCAL_PARTS = new Set([
  'info',
  'contact',
  'support',
  'admin',
  'office',
  'hello',
  'sales',
  'hr'
]);

// ─── Bounce-Risk: Classification ─────────────────────────────────────────────

export interface EmailBounceClassification {
  /** The email to store — empty string if hard-discarded. */
  email: string;
  /** True if the email is a generic role address (info@, contact@, etc.). */
  isGenericEmail: boolean;
  /** True if the email is from a freemail provider (gmail, yahoo, etc.). */
  isFreeEmail: boolean;
  /** True if the email is from a relay/platform domain or uses a "+" alias on a non-business domain. */
  isRelayEmail: boolean;
}

/**
 * Classifies a scraped email for bounce risk.
 *
 * Hard discard rules (returns email = ''):
 * 1. Domain is in DISPOSABLE_DOMAINS
 * 2. Domain is in RELAY_DOMAINS
 * 3. Local part is in HARD_DISCARD_LOCAL_PARTS
 * 4. Email uses "+" alias AND domain is not the business domain AND not a freemail domain
 *
 * Flag rules (email kept, flags set):
 * - isGenericEmail: local part is in GENERIC_LOCAL_PARTS
 * - isFreeEmail: domain is in FREEMAIL_DOMAINS
 * - isRelayEmail: domain is in RELAY_DOMAINS (already hard-discarded, but flag set for logging)
 *                 OR email uses "+" alias on a non-business, non-freemail domain
 *
 * @param email            - Normalised (lowercase) email string
 * @param companyRootDomain - Root domain of the business website (e.g. "acme.com")
 */
export function classifyEmailBounceRisk(
  email: string,
  companyRootDomain: string
): EmailBounceClassification {
  const empty: EmailBounceClassification = {
    email: '',
    isGenericEmail: false,
    isFreeEmail: false,
    isRelayEmail: false,
  };

  if (!email || !email.includes('@')) return empty;

  const [localRaw, domainRaw] = email.split('@');
  const local = (localRaw ?? '').toLowerCase();
  const domain = (domainRaw ?? '').toLowerCase();

  // ── Hard discard: disposable domain ──────────────────────────────────────
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return empty;
  }

  // ── Hard discard: relay/platform domain ──────────────────────────────────
  if (RELAY_DOMAINS.has(domain)) {
    return empty;
  }

  // ── Hard discard: system/role local part ─────────────────────────────────
  // Strip "+" alias before checking (e.g. noreply+123 → noreply)
  const localBase = local.split('+')[0];
  if (HARD_DISCARD_LOCAL_PARTS.has(localBase)) {
    return empty;
  }

  // ── Hard discard: "+" alias on non-business, non-freemail domain ─────────
  const hasAlias = local.includes('+');
  const isFreemailDomain = FREEMAIL_DOMAINS.includes(domain);
  const isBusinessDomain = companyRootDomain
    ? (parseTld(domain)?.domain ?? domain) === companyRootDomain
    : false;

  if (hasAlias && !isBusinessDomain && !isFreemailDomain) {
    return empty;
  }

  // ── Flags ─────────────────────────────────────────────────────────────────
  const isGenericEmail = GENERIC_LOCAL_PARTS.has(localBase);
  const isFreeEmail = isFreemailDomain;
  const isRelayEmail = RELAY_DOMAINS.has(domain) ||
    (hasAlias && !isBusinessDomain && !isFreemailDomain);

  return { email, isGenericEmail, isFreeEmail, isRelayEmail };
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

/**
 * Substrings that disqualify an email address.
 * Checked against the full email string (case-insensitive).
 */
const EMAIL_BLACKLIST: string[] = [
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'example.com',
  'sentry',
  'cloudflare',
  'amazonaws',
  'google',
  'facebook',
  'wixpress.com',
];

// ─── Freemail Domains ─────────────────────────────────────────────────────────

/**
 * Common freemail domains used only as a last-resort fallback.
 * A freemail address is returned only when no company-domain or
 * non-freemail address survives filtering.
 */
const FREEMAIL_DOMAINS: string[] = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'mail.com',
  'protonmail.com',
  'yandex.com',
  'zoho.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.com.au',
];

// ─── Noise Patterns ───────────────────────────────────────────────────────────

/**
 * Regex patterns that identify script/analytics noise emails.
 * Matched against the full email string.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^webpack@/i,
  /^sourcemap@/i,
  /^tracking@/i,
  /^pixel@/i,
  /^analytics@/i,
  /^error@/i,
  /^test@/i,
  /^example@/i,
];

/** Maximum allowed length for the local part (before @). */
const MAX_LOCAL_PART_LENGTH = 50;

// ─── Email Regex ──────────────────────────────────────────────────────────────

const EMAIL_REGEX = /[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseEmail(raw: string): string {
  return decodeURIComponent(raw)
    .replace(/^mailto:/i, '')
    .split('?')[0]   // strip query params (e.g. ?subject=...)
    .trim()
    .toLowerCase();
}

function isValidEmailShape(email: string): boolean {
  return email.includes('@') && email.includes('.');
}

function isBlacklisted(email: string): boolean {
  return EMAIL_BLACKLIST.some((term) => email.includes(term));
}

function isNoise(email: string): boolean {
  const localPart = email.split('@')[0];
  if (localPart.length > MAX_LOCAL_PART_LENGTH) return true;
  return NOISE_PATTERNS.some((p) => p.test(email));
}

function isFreemail(email: string): boolean {
  const domain = email.split('@')[1] ?? '';
  return FREEMAIL_DOMAINS.includes(domain);
}

/**
 * Returns true if the email's domain matches the company's root domain.
 * Uses tldts to handle subdomains and multi-part TLDs correctly.
 */
function isCompanyDomainEmail(email: string, companyRootDomain: string): boolean {
  if (!companyRootDomain) return false;
  const emailDomain = email.split('@')[1] ?? '';
  const parsed = parseTld(emailDomain);
  return (parsed.domain ?? '') === companyRootDomain;
}

// ─── A2: MX Record Validation ─────────────────────────────────────────────────

/**
 * Validates an email address by checking:
 * 1. Strict RFC 5322 syntax
 * 2. MX record existence for the domain (cached, with 5s timeout)
 *
 * Returns true if the email has valid syntax AND the domain has at least one MX record.
 */
export async function isEmailDomainValid(email: string): Promise<boolean> {
  // Strict RFC 5322 syntax check
  const syntaxOk = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
  if (!syntaxOk) return false;

  const domain = email.split('@')[1];
  if (!domain) return false;

  // Check cache first
  if (mxCache.has(domain)) {
    return mxCache.get(domain)!;
  }

  // DNS MX lookup with a hard 5s timeout — prevents hanging on slow/unresponsive DNS
  try {
    const result = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MX timeout')), 2000)
      ),
    ]);
    const valid = result.length > 0;
    mxCache.set(domain, valid);
    return valid;
  } catch {
    // Timeout or DNS failure — assume valid to avoid discarding real emails
    // Cache as true so we don't retry on every lead from the same domain
    mxCache.set(domain, true);
    return true;
  }
}

// ─── A1: JSON-LD Structured Data Extraction ───────────────────────────────────

/**
 * Walks a parsed JSON-LD object (or array) looking for schema types that
 * contain contact information.
 */
function walkJsonLd(
  obj: unknown,
  result: { email: string; phone: string; address: string }
): void {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walkJsonLd(item, result);
    }
    return;
  }

  const node = obj as Record<string, unknown>;
  const type = node['@type'];
  const typeStr = typeof type === 'string' ? type : '';

  const CONTACT_TYPES = [
    'LocalBusiness',
    'Organization',
    'MedicalBusiness',
    'ProfessionalService',
    'ContactPoint',
  ];

  const isContactType = CONTACT_TYPES.some(
    (t) => typeStr === t || typeStr.includes(t)
  );

  if (isContactType) {
    // Extract email
    if (!result.email && typeof node['email'] === 'string' && node['email']) {
      result.email = normaliseEmail(node['email']);
    }

    // Extract telephone
    if (!result.phone && typeof node['telephone'] === 'string' && node['telephone']) {
      result.phone = (node['telephone'] as string).trim();
    }

    // Extract address
    if (!result.address) {
      const addr = node['address'];
      if (typeof addr === 'object' && addr !== null) {
        const addrObj = addr as Record<string, unknown>;
        const street = typeof addrObj['streetAddress'] === 'string' ? addrObj['streetAddress'] : '';
        const locality = typeof addrObj['addressLocality'] === 'string' ? addrObj['addressLocality'] : '';
        const parts = [street, locality].filter(Boolean);
        if (parts.length > 0) result.address = parts.join(', ');
      } else if (typeof addr === 'string' && addr) {
        result.address = addr;
      }
    }
  }

  // Recurse into contactPoint / contactPoints
  if (node['contactPoint']) walkJsonLd(node['contactPoint'], result);
  if (node['contactPoints']) walkJsonLd(node['contactPoints'], result);

  // Recurse into all child objects/arrays for nested schemas
  for (const key of Object.keys(node)) {
    if (key === 'contactPoint' || key === 'contactPoints') continue;
    const val = node[key];
    if (typeof val === 'object' && val !== null) {
      walkJsonLd(val, result);
    }
  }
}

/**
 * Extracts contact information from JSON-LD structured data embedded in HTML.
 *
 * @param html - Raw HTML string (used if $ is not provided)
 * @param $    - Optional pre-parsed Cheerio instance (avoids re-parsing)
 * @returns Object with email, phone, address (empty strings if not found)
 */
export function extractFromJsonLd(
  html: string,
  $?: ReturnType<typeof cheerio.load>
): { email: string; phone: string; address: string } {
  const result = { email: '', phone: '', address: '' };

  if (!html || html.trim().length === 0) return result;

  const doc = $ ?? cheerio.load(html);

  doc('script[type="application/ld+json"]').each((_, el) => {
    if (result.email && result.phone && result.address) return; // already found everything

    const content = doc(el).html() ?? '';
    if (!content.trim()) return;

    try {
      const parsed = JSON.parse(content);
      walkJsonLd(parsed, result);
    } catch {
      // Ignore malformed JSON-LD
    }
  });

  return result;
}

// ─── Main Extraction Function ─────────────────────────────────────────────────

/**
 * Extracts the best email address from page HTML.
 *
 * @param html            - Raw HTML string of the page
 * @param companyWebsite  - The business's website URL (used to derive company root domain)
 * @param parsed$         - Optional pre-parsed Cheerio instance (avoids re-parsing)
 * @returns               - Best email string, or empty string if none found
 *
 * Side effects:
 * - Increments store.failureMetrics.email_not_found when no email is found
 */
export async function extractEmail(
  html: string,
  companyWebsite: string,
  parsed$?: ReturnType<typeof cheerio.load>
): Promise<string> {
  if (!html || html.trim().length === 0) {
    store.incrementMetric('email_not_found');
    return '';
  }

  // Phase 5.5: truncate oversized HTML before parsing to reduce memory pressure
  const safeHtml = truncateHtmlIfNeeded(html);
  const $ = parsed$ ?? cheerio.load(safeHtml);

  // ── Step 0: JSON-LD extraction ────────────────────────────────────────────
  const jsonLdData = extractFromJsonLd(safeHtml, $);
  const mailtoEmails: string[] = [];

  if (jsonLdData.email) {
    const normalised = normaliseEmail(jsonLdData.email);
    if (normalised) {
      mailtoEmails.push(normalised);
    }
  }

  // ── Step 1: mailto links (highest confidence) ─────────────────────────────
  $('a[href^="mailto:"], a[href^="MAILTO:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const email = normaliseEmail(href);
    if (email) mailtoEmails.push(email);
  });

  // ── Step 2: regex scan of visible text ────────────────────────────────────
  // Use body text to avoid picking up emails from <script> or <style> blocks
  const bodyText = $('body').text();
  const regexMatches = [...bodyText.matchAll(EMAIL_REGEX)].map((m) =>
    normaliseEmail(m[0])
  );

  // ── Step 3: deduplicate (case-insensitive, already lowercased) ────────────
  const allEmails = [...new Set([...mailtoEmails, ...regexMatches])];

  // ── Step 4: blacklist filter ──────────────────────────────────────────────
  const afterBlacklist = allEmails.filter(
    (e) => isValidEmailShape(e) && !isBlacklisted(e)
  );

  // ── Step 5: noise filter ──────────────────────────────────────────────────
  const afterNoise = afterBlacklist.filter((e) => !isNoise(e));

  if (afterNoise.length === 0) {
    logger.info(`EmailExtractor: no email found for ${companyWebsite}`);
    store.incrementMetric('email_not_found');
    return '';
  }

  // ── Step 5.5: MX record validation ───────────────────────────────────────
  const validationResults = await Promise.all(afterNoise.map((e) => isEmailDomainValid(e)));
  const afterValidation = afterNoise.filter((_, i) => validationResults[i]);

  if (afterValidation.length === 0) {
    logger.warn(
      `EmailExtractor: all ${afterNoise.length} email(s) failed MX validation for ${companyWebsite}`
    );
    store.incrementMetric('email_not_found');
    return '';
  }

  // ── Step 6: rank by domain priority ──────────────────────────────────────
  const companyRootDomain = (() => {
    try {
      const parsed = parseTld(companyWebsite);
      return parsed.domain ?? '';
    } catch {
      return '';
    }
  })();

  const companyEmails = afterValidation.filter((e) =>
    isCompanyDomainEmail(e, companyRootDomain)
  );
  const nonFreemailEmails = afterValidation.filter((e) => !isFreemail(e));
  const freemailEmails = afterValidation.filter((e) => isFreemail(e));

  // Priority: company domain > non-freemail > freemail fallback
  const best =
    companyEmails[0] ??
    nonFreemailEmails[0] ??
    freemailEmails[0] ??
    '';

  if (!best) {
    store.incrementMetric('email_not_found');
    return '';
  }

  // ── Step 7: Bounce-risk hard discard ──────────────────────────────────────
  // Apply after ranking so we only check the single best candidate.
  const classification = classifyEmailBounceRisk(best, companyRootDomain);
  if (!classification.email) {
    logger.info(`EmailExtractor: hard-discarded "${best}" (bounce risk) for ${companyWebsite}`);
    store.incrementMetric('email_not_found');
    return '';
  }

  logger.info(`EmailExtractor: found "${best}" for ${companyWebsite}`);
  return best;
}

// ─── D2: Contact Form Detection ───────────────────────────────────────────────

/**
 * Detects whether the page contains a contact form.
 *
 * Checks for:
 * - <form> elements with at least 2 contact-related field names/ids
 * - Common contact form plugin class markers
 * - Form id/class containing contact/enquiry/inquiry
 *
 * @param html - Raw HTML string
 * @returns true if a contact form is detected
 */
export function detectContactForm(html: string): boolean {
  if (!html || html.trim().length === 0) return false;

  const $ = cheerio.load(html);

  // Contact form plugin class markers
  const PLUGIN_MARKERS = ['wpcf7', 'contact-form', 'gform', 'wpforms', 'ninja-forms'];

  // Check for plugin markers anywhere in the HTML
  const lowerHtml = html.toLowerCase();
  if (PLUGIN_MARKERS.some((m) => lowerHtml.includes(m))) {
    return true;
  }

  // Field name/id patterns that indicate a contact form
  const CONTACT_FIELD_PATTERNS = [
    'name', 'email', 'message', 'subject', 'phone',
    'enquiry', 'inquiry', 'contact',
  ];

  let found = false;

  $('form').each((_, formEl) => {
    if (found) return;

    const formHtml = $.html(formEl).toLowerCase();
    const formClass = ($(formEl).attr('class') ?? '').toLowerCase();
    const formId = ($(formEl).attr('id') ?? '').toLowerCase();

    // Check form id/class for contact/enquiry/inquiry
    if (
      formClass.includes('contact') ||
      formClass.includes('enquiry') ||
      formClass.includes('inquiry') ||
      formId.includes('contact') ||
      formId.includes('enquiry') ||
      formId.includes('inquiry')
    ) {
      found = true;
      return;
    }

    // Count matching field name/id patterns
    let matchCount = 0;
    for (const pattern of CONTACT_FIELD_PATTERNS) {
      // Check for name="pattern" or id="pattern" (partial match)
      if (
        formHtml.includes(`name="${pattern}`) ||
        formHtml.includes(`name='${pattern}`) ||
        formHtml.includes(`id="${pattern}`) ||
        formHtml.includes(`id='${pattern}`)
      ) {
        matchCount++;
      }
      if (matchCount >= 2) {
        found = true;
        return;
      }
    }
  });

  return found;
}

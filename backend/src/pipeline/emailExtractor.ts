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

// ─── MX Cache ─────────────────────────────────────────────────────────────────

/** Cache of domain → MX record validity to avoid repeated DNS lookups. */
const mxCache = new Map<string, boolean>();

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
  return raw
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
 * 2. MX record existence for the domain (cached)
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

  // DNS MX lookup
  try {
    const records = await dns.resolveMx(domain);
    const valid = records.length > 0;
    mxCache.set(domain, valid);
    return valid;
  } catch {
    mxCache.set(domain, false);
    return false;
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
 * @param html - Raw HTML string
 * @returns Object with email, phone, address (empty strings if not found)
 */
export function extractFromJsonLd(html: string): { email: string; phone: string; address: string } {
  const result = { email: '', phone: '', address: '' };

  if (!html || html.trim().length === 0) return result;

  const $ = cheerio.load(html);

  $('script[type="application/ld+json"]').each((_, el) => {
    if (result.email && result.phone && result.address) return; // already found everything

    const content = $(el).html() ?? '';
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
 * @returns               - Best email string, or empty string if none found
 *
 * Side effects:
 * - Increments store.failureMetrics.email_not_found when no email is found
 */
export async function extractEmail(html: string, companyWebsite: string): Promise<string> {
  if (!html || html.trim().length === 0) {
    store.incrementMetric('email_not_found');
    return '';
  }

  const $ = cheerio.load(html);

  // ── Step 0: JSON-LD extraction ────────────────────────────────────────────
  const jsonLdData = extractFromJsonLd(html);
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

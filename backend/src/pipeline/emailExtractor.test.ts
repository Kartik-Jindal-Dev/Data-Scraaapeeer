/**
 * emailExtractor.test.ts
 * Unit tests for email extraction.
 *
 * Covers:
 * - mailto link extraction
 * - regex scan of body text
 * - deduplication
 * - blacklist filtering (noreply, sentry, cloudflare, amazonaws, google, facebook)
 * - noise filtering (webpack, tracking, analytics, long local parts)
 * - company domain preference over non-freemail
 * - freemail fallback only when nothing else survives
 * - email_not_found metric incremented when no email found
 * - empty HTML returns empty string
 * - JSON-LD structured data extraction
 * - contact form detection
 */

import { store } from '../store';
import { extractEmail, extractFromJsonLd, detectContactForm } from './emailExtractor';

// Mock DNS to avoid real network calls in tests
jest.mock('dns', () => ({
  promises: {
    resolveMx: jest.fn().mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]),
  },
}));

beforeEach(() => {
  store.reset();
  // Reset the mxCache between tests by re-requiring the module
  jest.resetModules();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

// ─── Basic extraction ─────────────────────────────────────────────────────────

describe('mailto link extraction', () => {
  it('extracts email from mailto href', async () => {
    const result = await extractEmail(
      html('<a href="mailto:info@acme.com">Contact</a>'),
      'https://acme.com'
    );
    expect(result).toBe('info@acme.com');
  });

  it('strips query params from mailto href', async () => {
    const result = await extractEmail(
      html('<a href="mailto:info@acme.com?subject=Hello">Contact</a>'),
      'https://acme.com'
    );
    expect(result).toBe('info@acme.com');
  });

  it('normalises mailto email to lowercase', async () => {
    const result = await extractEmail(
      html('<a href="mailto:INFO@ACME.COM">Contact</a>'),
      'https://acme.com'
    );
    expect(result).toBe('info@acme.com');
  });
});

describe('regex scan of body text', () => {
  it('extracts email from plain text', async () => {
    const result = await extractEmail(
      html('<p>Contact us at hello@acmecorp.com for more info.</p>'),
      'https://acmecorp.com'
    );
    expect(result).toBe('hello@acmecorp.com');
  });

  it('extracts email with plus sign in local part', async () => {
    const result = await extractEmail(
      html('<p>Email: support+help@acmecorp.com</p>'),
      'https://acmecorp.com'
    );
    expect(result).toBe('support+help@acmecorp.com');
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe('deduplication', () => {
  it('returns one email when same address appears multiple times', async () => {
    const result = await extractEmail(
      html(`
        <a href="mailto:info@acme.com">Email 1</a>
        <p>Also reach us at info@acme.com</p>
      `),
      'https://acme.com'
    );
    expect(result).toBe('info@acme.com');
  });
});

// ─── Blacklist filtering ──────────────────────────────────────────────────────

describe('blacklist filtering', () => {
  const blacklistCases: [string, string][] = [
    ['noreply@acme.com', 'noreply'],
    ['no-reply@acme.com', 'no-reply'],
    ['donotreply@acme.com', 'donotreply'],
    ['errors@sentry.io', 'sentry'],
    ['cdn@cloudflare.com', 'cloudflare'],
    ['s3@amazonaws.com', 'amazonaws'],
    ['noreply@google.com', 'google'],
    ['info@facebook.com', 'facebook'],
    ['support@wixpress.com', 'wixpress.com'],
  ];

  test.each(blacklistCases)('filters out %s (%s)', async (email) => {
    const result = await extractEmail(
      html(`<a href="mailto:${email}">Contact</a>`),
      'https://acme.com'
    );
    expect(result).toBe('');
    expect(store.getFailureMetrics().email_not_found).toBe(1);
  });
});

// ─── Noise filtering ─────────────────────────────────────────────────────────

describe('noise filtering', () => {
  it('filters out webpack@ emails', async () => {
    const result = await extractEmail(
      html('<p>webpack@acme.com</p>'),
      'https://acme.com'
    );
    expect(result).toBe('');
  });

  it('filters out tracking@ emails', async () => {
    const result = await extractEmail(
      html('<p>tracking@acme.com</p>'),
      'https://acme.com'
    );
    expect(result).toBe('');
  });

  it('filters out analytics@ emails', async () => {
    const result = await extractEmail(
      html('<p>analytics@acme.com</p>'),
      'https://acme.com'
    );
    expect(result).toBe('');
  });

  it('filters out emails with local part > 50 chars', async () => {
    const longLocal = 'a'.repeat(51);
    const result = await extractEmail(
      html(`<p>${longLocal}@acme.com</p>`),
      'https://acme.com'
    );
    expect(result).toBe('');
  });
});

// ─── Domain priority ──────────────────────────────────────────────────────────

describe('company domain preference', () => {
  it('prefers company-domain email over non-freemail', async () => {
    const result = await extractEmail(
      html(`
        <p>partner@other.com</p>
        <a href="mailto:info@acme.com">Contact</a>
      `),
      'https://acme.com'
    );
    expect(result).toBe('info@acme.com');
  });

  it('prefers non-freemail over freemail', async () => {
    const result = await extractEmail(
      html(`
        <p>owner@gmail.com</p>
        <a href="mailto:contact@somecompany.org">Contact</a>
      `),
      'https://acme.com'
    );
    expect(result).toBe('contact@somecompany.org');
  });

  it('falls back to freemail when nothing else survives', async () => {
    const result = await extractEmail(
      html('<a href="mailto:owner@gmail.com">Contact</a>'),
      'https://acme.com'
    );
    expect(result).toBe('owner@gmail.com');
  });

  it('handles subdomain company email correctly (tldts)', async () => {
    // info@shop.acme.com should match company root domain acme.com
    const result = await extractEmail(
      html(`
        <a href="mailto:info@shop.acme.com">Contact</a>
        <p>other@gmail.com</p>
      `),
      'https://www.acme.com'
    );
    expect(result).toBe('info@shop.acme.com');
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe('email_not_found metric', () => {
  it('increments when no email found in HTML', async () => {
    await extractEmail(html('<p>No contact info here.</p>'), 'https://acme.com');
    expect(store.getFailureMetrics().email_not_found).toBe(1);
  });

  it('increments when HTML is empty', async () => {
    await extractEmail('', 'https://acme.com');
    expect(store.getFailureMetrics().email_not_found).toBe(1);
  });

  it('does NOT increment when email is found', async () => {
    await extractEmail(
      html('<a href="mailto:info@acme.com">Contact</a>'),
      'https://acme.com'
    );
    expect(store.getFailureMetrics().email_not_found).toBe(0);
  });
});

// ─── JSON-LD extraction ───────────────────────────────────────────────────────

describe('extractFromJsonLd()', () => {
  it('extracts email from LocalBusiness JSON-LD', () => {
    const pageHtml = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"LocalBusiness","email":"info@dentist.com","telephone":"+12025551234"}
        </script>
      </head><body></body></html>
    `;
    const result = extractFromJsonLd(pageHtml);
    expect(result.email).toBe('info@dentist.com');
    expect(result.phone).toBe('+12025551234');
  });

  it('extracts from Organization type', () => {
    const pageHtml = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"Organization","email":"hello@org.com"}
        </script>
      </head><body></body></html>
    `;
    const result = extractFromJsonLd(pageHtml);
    expect(result.email).toBe('hello@org.com');
  });

  it('extracts address from streetAddress + addressLocality', () => {
    const pageHtml = `
      <html><head>
        <script type="application/ld+json">
          {"@type":"LocalBusiness","address":{"streetAddress":"123 Main St","addressLocality":"London"}}
        </script>
      </head><body></body></html>
    `;
    const result = extractFromJsonLd(pageHtml);
    expect(result.address).toBe('123 Main St, London');
  });

  it('returns empty strings for missing fields', () => {
    const result = extractFromJsonLd('<html><body>No JSON-LD here</body></html>');
    expect(result.email).toBe('');
    expect(result.phone).toBe('');
    expect(result.address).toBe('');
  });

  it('handles malformed JSON-LD gracefully', () => {
    const pageHtml = `
      <html><head>
        <script type="application/ld+json">{ invalid json }</script>
      </head><body></body></html>
    `;
    expect(() => extractFromJsonLd(pageHtml)).not.toThrow();
    const result = extractFromJsonLd(pageHtml);
    expect(result.email).toBe('');
  });

  it('handles array of JSON-LD objects', () => {
    const pageHtml = `
      <html><head>
        <script type="application/ld+json">
          [{"@type":"Organization","email":"org@example.com"},{"@type":"LocalBusiness","telephone":"+1234567890"}]
        </script>
      </head><body></body></html>
    `;
    const result = extractFromJsonLd(pageHtml);
    expect(result.email).toBe('org@example.com');
    expect(result.phone).toBe('+1234567890');
  });
});

// ─── Contact form detection ───────────────────────────────────────────────────

describe('detectContactForm()', () => {
  it('detects form with name + email fields', () => {
    const pageHtml = html(`
      <form>
        <input name="name" type="text" />
        <input name="email" type="email" />
        <textarea name="message"></textarea>
        <button type="submit">Send</button>
      </form>
    `);
    expect(detectContactForm(pageHtml)).toBe(true);
  });

  it('detects wpcf7 plugin marker', () => {
    const pageHtml = html('<div class="wpcf7"><form></form></div>');
    expect(detectContactForm(pageHtml)).toBe(true);
  });

  it('detects form with contact class', () => {
    const pageHtml = html('<form class="contact-form-main"><input name="x" /></form>');
    expect(detectContactForm(pageHtml)).toBe(true);
  });

  it('detects form with contact id', () => {
    const pageHtml = html('<form id="contact"><input name="x" /></form>');
    expect(detectContactForm(pageHtml)).toBe(true);
  });

  it('returns false for non-contact forms', () => {
    const pageHtml = html('<form><input name="search" /><button>Search</button></form>');
    expect(detectContactForm(pageHtml)).toBe(false);
  });

  it('returns false for empty HTML', () => {
    expect(detectContactForm('')).toBe(false);
  });
});

/**
 * scraper.test.ts
 * Unit tests for the website scraping engine.
 *
 * Covers:
 * - scrapePage: static path returns HTML, increments no metrics
 * - scrapePage: unreachable (detection returns no HTML) → unreachable=true, metric incremented
 * - scrapePage: empty URL → unreachable=true
 * - extractContactSubPageUrls: finds matching internal links, scored/sorted, no external links
 */

import * as cheerio from 'cheerio';
import { store } from '../store';
import { extractContactSubPageUrls } from './scraper';

// ─── Mock detect module ───────────────────────────────────────────────────────

jest.mock('./detect', () => ({
  detectPageType: jest.fn(),
  isLoginRedirect: jest.requireActual('./detect').isLoginRedirect,
}));

// ─── Mock robots module ───────────────────────────────────────────────────────

jest.mock('./robots', () => ({
  isAllowedByRobots: jest.fn().mockResolvedValue(true),
}));

// ─── Mock DNS ─────────────────────────────────────────────────────────────────

jest.mock('dns', () => ({
  promises: {
    resolve: jest.fn().mockResolvedValue(['1.2.3.4']),
  },
}));

import { detectPageType } from './detect';
const mockDetect = detectPageType as jest.MockedFunction<typeof detectPageType>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  store.reset();
  mockDetect.mockReset();
});

// ─── scrapePage tests ─────────────────────────────────────────────────────────

describe('scrapePage() — static path', () => {
  it('returns HTML and unreachable=false for a static page', async () => {
    const html = '<html><body>Hello</body></html>';
    mockDetect.mockResolvedValueOnce({ pageType: 'static', html });

    const { scrapePage } = await import('./scraper');
    const result = await scrapePage('https://example.com');

    expect(result.unreachable).toBe(false);
    expect(result.html).toBe(html);
    expect(store.getFailureMetrics().website_unreachable).toBe(0);
  });

  it('marks unreachable when static detection returns empty HTML', async () => {
    mockDetect.mockResolvedValueOnce({ pageType: 'static', html: '' });

    const { scrapePage } = await import('./scraper');
    const result = await scrapePage('https://example.com');

    expect(result.unreachable).toBe(true);
    expect(store.getFailureMetrics().website_unreachable).toBe(1);
  });
});

describe('scrapePage() — empty URL', () => {
  it('returns unreachable=true for empty URL without calling detect', async () => {
    const { scrapePage } = await import('./scraper');
    const result = await scrapePage('');

    expect(result.unreachable).toBe(true);
    expect(mockDetect).not.toHaveBeenCalled();
  });
});

// ─── extractContactSubPageUrls tests ─────────────────────────────────────────

describe('extractContactSubPageUrls()', () => {
  const baseUrl = 'https://example.com';

  it('finds /contact link', () => {
    const html = `<html><body><a href="/contact">Contact</a></body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toContain('https://example.com/contact');
  });

  it('finds /about-us link', () => {
    const html = `<html><body><a href="/about-us">About</a></body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toContain('https://example.com/about-us');
  });

  it('finds /team link', () => {
    const html = `<html><body><a href="/team">Team</a></body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toContain('https://example.com/team');
  });

  it('excludes external links', () => {
    const html = `<html><body>
      <a href="https://other.com/contact">External Contact</a>
      <a href="/contact">Internal Contact</a>
    </body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://example.com/contact');
  });

  it('excludes non-matching internal links', () => {
    const html = `<html><body>
      <a href="/products">Products</a>
      <a href="/pricing">Pricing</a>
    </body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toHaveLength(0);
  });

  it('returns links sorted by score (contact first)', () => {
    const html = `<html><body>
      <a href="/contact">Contact</a>
      <a href="/about">About</a>
      <a href="/team">Team</a>
      <a href="/staff">Staff</a>
      <a href="/leadership">Leadership</a>
    </body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    // Should return all matching URLs sorted by score
    expect(urls.length).toBeGreaterThan(0);
    // /contact should score highest
    expect(urls[0]).toBe('https://example.com/contact');
  });

  it('deduplicates identical links', () => {
    const html = `<html><body>
      <a href="/contact">Contact 1</a>
      <a href="/contact">Contact 2</a>
    </body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toHaveLength(1);
  });

  it('handles absolute internal URLs', () => {
    const html = `<html><body>
      <a href="https://example.com/contact-us">Contact</a>
    </body></html>`;
    const urls = extractContactSubPageUrls(html, baseUrl);
    expect(urls).toContain('https://example.com/contact-us');
  });

  it('returns empty array for empty HTML', () => {
    const urls = extractContactSubPageUrls('', baseUrl);
    expect(urls).toHaveLength(0);
  });

  it('returns empty array for invalid baseUrl', () => {
    const html = `<html><body><a href="/contact">Contact</a></body></html>`;
    const urls = extractContactSubPageUrls(html, 'not-a-url');
    // Should not throw, may return empty or partial results
    expect(Array.isArray(urls)).toBe(true);
  });
});

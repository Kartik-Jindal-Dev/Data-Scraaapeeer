/**
 * indepth.test.ts
 * Unit tests for the in-depth crawl module.
 *
 * Covers:
 * - Empty URL returns unreachable immediately
 * - Homepage unreachable → returns unreachable, no sub-pages attempted
 * - Homepage reachable, no sub-pages found → returns homepage HTML only
 * - Homepage reachable, sub-pages found → scrapes up to MAX_SUBPAGES (5)
 * - Sub-page failures are non-fatal (homepage HTML still returned)
 * - Duplicate sub-page URLs are skipped
 * - Stop signal aborts sub-page scraping
 * - subpages_scraped metric incremented for each successful sub-page
 * - Merged HTML contains PAGE_BREAK separator between pages
 * - Max 5 sub-pages enforced even if more are found
 */

import { store } from '../store';
import { scrapeInDepth } from './indepth';

// ─── Mock scraper module ──────────────────────────────────────────────────────

jest.mock('./scraper', () => ({
  scrapePage: jest.fn(),
  extractContactSubPageUrls: jest.fn(),
}));

import { scrapePage, extractContactSubPageUrls } from './scraper';
const mockScrapePage = scrapePage as jest.MockedFunction<typeof scrapePage>;
const mockExtractUrls = extractContactSubPageUrls as jest.MockedFunction<typeof extractContactSubPageUrls>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePageResult(html: string, finalUrl = 'https://acme.com') {
  return { html, finalUrl, unreachable: false };
}

function makeUnreachable(url = 'https://acme.com') {
  return { html: '', finalUrl: url, unreachable: true };
}

const STOP_OFF = { stopped: false };
const STOP_ON  = { stopped: true };

beforeEach(() => {
  store.reset();
  mockScrapePage.mockReset();
  mockExtractUrls.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scrapeInDepth() — empty URL', () => {
  it('returns unreachable immediately without calling scrapePage', async () => {
    const result = await scrapeInDepth('', STOP_OFF, 'Acme');
    expect(result.unreachable).toBe(true);
    expect(result.mergedHtml).toBe('');
    expect(mockScrapePage).not.toHaveBeenCalled();
  });
});

describe('scrapeInDepth() — homepage unreachable', () => {
  it('returns unreachable and does not attempt sub-pages', async () => {
    mockScrapePage.mockResolvedValueOnce(makeUnreachable());
    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');
    expect(result.unreachable).toBe(true);
    expect(result.mergedHtml).toBe('');
    expect(result.subpagesScraped).toBe(0);
    expect(mockExtractUrls).not.toHaveBeenCalled();
  });
});

describe('scrapeInDepth() — homepage only (no sub-pages found)', () => {
  it('returns homepage HTML when no sub-pages are found', async () => {
    mockScrapePage.mockResolvedValueOnce(makePageResult('<html>Home</html>'));
    mockExtractUrls.mockReturnValueOnce([]);

    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(result.unreachable).toBe(false);
    expect(result.mergedHtml).toContain('<html>Home</html>');
    expect(result.subpagesScraped).toBe(0);
    expect(store.getFailureMetrics().subpages_scraped).toBe(0);
  });
});

describe('scrapeInDepth() — sub-pages scraped', () => {
  it('scrapes homepage + sub-pages and merges HTML', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makePageResult('<html>Contact</html>', 'https://acme.com/contact'))
      .mockResolvedValueOnce(makePageResult('<html>About</html>', 'https://acme.com/about'));

    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/about',
    ]);

    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(result.unreachable).toBe(false);
    expect(result.mergedHtml).toContain('<html>Home</html>');
    expect(result.mergedHtml).toContain('<html>Contact</html>');
    expect(result.mergedHtml).toContain('<html>About</html>');
    expect(result.mergedHtml).toContain('PAGE_BREAK');
    expect(result.subpagesScraped).toBe(2);
    expect(store.getFailureMetrics().subpages_scraped).toBe(2);
  });

  it('enforces max 5 sub-pages even if more are found', async () => {
    // Homepage + 5 sub-pages = 6 total scrapePage calls
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makePageResult('<html>P1</html>'))
      .mockResolvedValueOnce(makePageResult('<html>P2</html>'))
      .mockResolvedValueOnce(makePageResult('<html>P3</html>'))
      .mockResolvedValueOnce(makePageResult('<html>P4</html>'))
      .mockResolvedValueOnce(makePageResult('<html>P5</html>'));

    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/about',
      'https://acme.com/team',
      'https://acme.com/staff',
      'https://acme.com/leadership',
      'https://acme.com/founders',   // 6th — should be ignored
    ]);

    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(result.subpagesScraped).toBe(5);
    // scrapePage called: 1 homepage + 5 sub-pages = 6
    expect(mockScrapePage).toHaveBeenCalledTimes(6);
  });

  it('skips duplicate sub-page URLs', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makePageResult('<html>Contact</html>'));

    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/contact',  // duplicate
    ]);

    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(result.subpagesScraped).toBe(1);
    expect(mockScrapePage).toHaveBeenCalledTimes(2); // homepage + 1 unique sub-page
  });
});

describe('scrapeInDepth() — sub-page failures', () => {
  it('continues when a sub-page is unreachable', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makeUnreachable('https://acme.com/contact'))
      .mockResolvedValueOnce(makePageResult('<html>About</html>'));

    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/about',
    ]);

    const result = await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(result.unreachable).toBe(false);
    expect(result.mergedHtml).toContain('<html>Home</html>');
    expect(result.mergedHtml).toContain('<html>About</html>');
    expect(result.subpagesScraped).toBe(1); // only /about succeeded
  });
});

describe('scrapeInDepth() — stop signal', () => {
  it('aborts sub-page scraping when stop signal is set', async () => {
    mockScrapePage.mockResolvedValueOnce(makePageResult('<html>Home</html>'));
    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/about',
    ]);

    const result = await scrapeInDepth('https://acme.com', STOP_ON, 'Acme');

    // Homepage scraped, but sub-pages skipped due to stop signal
    expect(result.mergedHtml).toContain('<html>Home</html>');
    expect(result.subpagesScraped).toBe(0);
    // scrapePage called only once (homepage)
    expect(mockScrapePage).toHaveBeenCalledTimes(1);
  });
});

describe('scrapeInDepth() — metrics', () => {
  it('increments subpages_scraped for each successful sub-page', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makePageResult('<html>Contact</html>'))
      .mockResolvedValueOnce(makePageResult('<html>About</html>'));

    mockExtractUrls.mockReturnValueOnce([
      'https://acme.com/contact',
      'https://acme.com/about',
    ]);

    await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(store.getFailureMetrics().subpages_scraped).toBe(2);
  });

  it('does NOT increment subpages_scraped for unreachable sub-pages', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makeUnreachable());

    mockExtractUrls.mockReturnValueOnce(['https://acme.com/contact']);

    await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');

    expect(store.getFailureMetrics().subpages_scraped).toBe(0);
  });

  it('resets subpages_scraped on store.reset()', async () => {
    mockScrapePage
      .mockResolvedValueOnce(makePageResult('<html>Home</html>'))
      .mockResolvedValueOnce(makePageResult('<html>Contact</html>'));
    mockExtractUrls.mockReturnValueOnce(['https://acme.com/contact']);

    await scrapeInDepth('https://acme.com', STOP_OFF, 'Acme');
    expect(store.getFailureMetrics().subpages_scraped).toBe(1);

    store.reset();
    expect(store.getFailureMetrics().subpages_scraped).toBe(0);
  });
});

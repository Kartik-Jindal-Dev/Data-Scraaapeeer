/**
 * detect.test.ts
 * Unit tests for the static/dynamic page detector.
 *
 * Covers:
 * - Static page: no JS markers, fast response → 'static' + HTML returned
 * - Dynamic page: JS framework marker present → 'dynamic'
 * - Timeout (AbortError) → 'dynamic'
 * - Non-2xx HTTP status → 'dynamic'
 * - Login redirect URL → 'dynamic'
 * - Empty/missing URL → 'dynamic'
 * - isLoginRedirect() helper
 */

import { detectPageType, isLoginRedirect } from './detect';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockResponse(html: string, status = 200, finalUrl = 'https://example.com') {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl,
    text: async () => html,
  });
}

function mockTimeout() {
  mockFetch.mockRejectedValueOnce(
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  );
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error('Network failure'));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockFetch.mockReset();
});

describe('isLoginRedirect()', () => {
  it('returns true for /login path', () => {
    expect(isLoginRedirect('https://example.com/login')).toBe(true);
  });

  it('returns true for /signin path', () => {
    expect(isLoginRedirect('https://example.com/signin')).toBe(true);
  });

  it('returns true for /wp-login path', () => {
    expect(isLoginRedirect('https://example.com/wp-login.php')).toBe(true);
  });

  it('returns false for a normal page URL', () => {
    expect(isLoginRedirect('https://example.com/about')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLoginRedirect('')).toBe(false);
  });
});

describe('detectPageType()', () => {
  it('returns static for plain HTML with no JS markers', async () => {
    const html = '<html><body><h1>Hello World</h1></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://example.com');
    expect(result.pageType).toBe('static');
    expect(result.html).toBe(html);
  });

  it('returns dynamic when __NEXT_DATA__ marker is present', async () => {
    const html = '<html><body><script id="__NEXT_DATA__">{}</script></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://nextjs-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic when react marker is present', async () => {
    const html = '<html><body><div id="root" data-reactroot=""></div></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://react-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic when vue marker is present', async () => {
    const html = '<html><body><div id="app" data-v-app=""><!-- vue --></div></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://vue-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic when angular ng-version marker is present', async () => {
    const html = '<html><body><app-root ng-version="17.0.0"></app-root></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://angular-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic on fetch timeout (AbortError)', async () => {
    mockTimeout();
    const result = await detectPageType('https://slow-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic on network error', async () => {
    mockNetworkError();
    const result = await detectPageType('https://broken-site.com');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic for HTTP 404', async () => {
    mockResponse('<html>Not Found</html>', 404);
    const result = await detectPageType('https://example.com/missing');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic for HTTP 500', async () => {
    mockResponse('<html>Server Error</html>', 500);
    const result = await detectPageType('https://example.com/error');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic when final URL is a login redirect', async () => {
    const html = '<html><body>Login required</body></html>';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://example.com/login',
      text: async () => html,
    });
    const result = await detectPageType('https://example.com/dashboard');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
  });

  it('returns dynamic for empty URL', async () => {
    const result = await detectPageType('');
    expect(result.pageType).toBe('dynamic');
    expect(result.html).toBe('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('is case-insensitive for JS framework markers', async () => {
    // Markers are checked against lowercased HTML
    const html = '<html><body><script>window.__NEXT_DATA__ = {}</script></body></html>';
    mockResponse(html);
    const result = await detectPageType('https://example.com');
    expect(result.pageType).toBe('dynamic');
  });
});

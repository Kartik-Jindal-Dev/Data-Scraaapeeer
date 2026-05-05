/**
 * antiBlocking.test.ts
 * Unit tests for the anti-blocking utilities.
 *
 * Covers:
 * - pickUserAgent: returns a string, varies across calls
 * - pickViewport: returns valid dimensions, varies across calls
 * - getExtraHeaders: returns required header keys
 * - getProxyConfig: parses valid URLs, handles auth, rejects invalid, returns undefined when empty
 */

import { getExtraHeaders, getProxyConfig, pickUserAgent, pickViewport } from './antiBlocking';

// ─── pickUserAgent ────────────────────────────────────────────────────────────

describe('pickUserAgent()', () => {
  it('returns a non-empty string', () => {
    expect(typeof pickUserAgent()).toBe('string');
    expect(pickUserAgent().length).toBeGreaterThan(0);
  });

  it('contains a browser identifier', () => {
    const ua = pickUserAgent();
    const hasBrowser =
      ua.includes('Chrome') || ua.includes('Firefox') || ua.includes('Edg');
    expect(hasBrowser).toBe(true);
  });

  it('returns different values across multiple calls (pool rotation)', () => {
    const results = new Set(Array.from({ length: 20 }, () => pickUserAgent()));
    // With 9 UAs in the pool, 20 random picks should produce at least 2 distinct values
    expect(results.size).toBeGreaterThan(1);
  });
});

// ─── pickViewport ─────────────────────────────────────────────────────────────

describe('pickViewport()', () => {
  it('returns an object with width and height', () => {
    const vp = pickViewport();
    expect(typeof vp.width).toBe('number');
    expect(typeof vp.height).toBe('number');
  });

  it('returns reasonable screen dimensions', () => {
    const vp = pickViewport();
    expect(vp.width).toBeGreaterThanOrEqual(1024);
    expect(vp.height).toBeGreaterThanOrEqual(600);
  });

  it('returns different values across multiple calls (pool rotation)', () => {
    const results = new Set(
      Array.from({ length: 20 }, () => `${pickViewport().width}x${pickViewport().height}`)
    );
    expect(results.size).toBeGreaterThan(1);
  });
});

// ─── getExtraHeaders ──────────────────────────────────────────────────────────

describe('getExtraHeaders()', () => {
  it('returns an object', () => {
    expect(typeof getExtraHeaders()).toBe('object');
  });

  it('includes Accept-Language header', () => {
    expect(getExtraHeaders()['Accept-Language']).toBeDefined();
  });

  it('includes Accept header', () => {
    expect(getExtraHeaders()['Accept']).toBeDefined();
  });

  it('includes Sec-Fetch-Mode header', () => {
    expect(getExtraHeaders()['Sec-Fetch-Mode']).toBeDefined();
  });

  it('returns a new object each call (no shared reference)', () => {
    const h1 = getExtraHeaders();
    const h2 = getExtraHeaders();
    expect(h1).not.toBe(h2);
  });
});

// ─── getProxyConfig ───────────────────────────────────────────────────────────

describe('getProxyConfig()', () => {
  const originalEnv = process.env.PROXY_URL;

  afterEach(() => {
    process.env.PROXY_URL = originalEnv;
  });

  it('returns undefined when PROXY_URL is not set', () => {
    delete process.env.PROXY_URL;
    expect(getProxyConfig()).toBeUndefined();
  });

  it('returns undefined when PROXY_URL is empty string', () => {
    process.env.PROXY_URL = '';
    expect(getProxyConfig()).toBeUndefined();
  });

  it('returns undefined when PROXY_URL is whitespace only', () => {
    process.env.PROXY_URL = '   ';
    expect(getProxyConfig()).toBeUndefined();
  });

  it('parses a simple proxy URL without auth', () => {
    process.env.PROXY_URL = 'http://proxy.example.com:8080';
    const config = getProxyConfig();
    expect(config).toBeDefined();
    expect(config!.server).toBe('http://proxy.example.com:8080');
    expect(config!.username).toBeUndefined();
    expect(config!.password).toBeUndefined();
  });

  it('parses a proxy URL with username and password', () => {
    process.env.PROXY_URL = 'http://user:secret@proxy.example.com:8080';
    const config = getProxyConfig();
    expect(config).toBeDefined();
    expect(config!.server).toBe('http://proxy.example.com:8080');
    expect(config!.username).toBe('user');
    expect(config!.password).toBe('secret');
  });

  it('parses a SOCKS5 proxy URL', () => {
    process.env.PROXY_URL = 'socks5://proxy.example.com:1080';
    const config = getProxyConfig();
    expect(config).toBeDefined();
    expect(config!.server).toBe('socks5://proxy.example.com:1080');
  });

  it('returns undefined for an invalid URL', () => {
    process.env.PROXY_URL = 'not-a-valid-url';
    expect(getProxyConfig()).toBeUndefined();
  });

  it('URL-decodes special characters in username and password', () => {
    process.env.PROXY_URL = 'http://user%40name:p%40ss@proxy.example.com:8080';
    const config = getProxyConfig();
    expect(config!.username).toBe('user@name');
    expect(config!.password).toBe('p@ss');
  });
});

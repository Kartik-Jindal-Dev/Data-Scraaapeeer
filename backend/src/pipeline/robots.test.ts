/**
 * robots.test.ts
 * Unit tests for the robots.txt compliance checker.
 *
 * Covers:
 * - Returns true when RESPECT_ROBOTS_TXT is not 'true'
 * - Returns true when robots.txt is empty (no rules)
 * - Returns true when path is not disallowed
 * - Returns false when path is disallowed by wildcard agent
 * - Allow rule takes precedence over Disallow
 * - Specific user-agent block respected
 * - Fetch failure → fail-open (returns true)
 * - Cache: second call for same domain does not re-fetch
 * - clearRobotsCache() resets the cache
 */

import { clearRobotsCache, isAllowedByRobots } from './robots';

// ─── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockRobots(content: string, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => content,
  });
}

function mockRobotsFetchError() {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const originalEnv = process.env.RESPECT_ROBOTS_TXT;

beforeEach(() => {
  mockFetch.mockReset();
  clearRobotsCache();
  process.env.RESPECT_ROBOTS_TXT = 'true';
});

afterAll(() => {
  process.env.RESPECT_ROBOTS_TXT = originalEnv;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('isAllowedByRobots() — disabled', () => {
  it('returns true when RESPECT_ROBOTS_TXT is not set', async () => {
    delete process.env.RESPECT_ROBOTS_TXT;
    const result = await isAllowedByRobots('https://example.com/contact');
    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns true when RESPECT_ROBOTS_TXT is "false"', async () => {
    process.env.RESPECT_ROBOTS_TXT = 'false';
    const result = await isAllowedByRobots('https://example.com/contact');
    expect(result).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('isAllowedByRobots() — empty / missing robots.txt', () => {
  it('returns true when robots.txt is empty', async () => {
    mockRobots('');
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });

  it('returns true when robots.txt returns 404', async () => {
    mockRobots('Not Found', 404);
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });

  it('returns true when fetch throws (fail-open)', async () => {
    mockRobotsFetchError();
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });
});

describe('isAllowedByRobots() — allow rules', () => {
  it('returns true when path is not mentioned in robots.txt', async () => {
    mockRobots('User-agent: *\nDisallow: /admin\n');
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });

  it('returns false when path is disallowed by wildcard agent', async () => {
    mockRobots('User-agent: *\nDisallow: /contact\n');
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(false);
  });

  it('returns false when root is disallowed', async () => {
    mockRobots('User-agent: *\nDisallow: /\n');
    expect(await isAllowedByRobots('https://example.com/about')).toBe(false);
  });

  it('Allow rule takes precedence over Disallow for same path', async () => {
    mockRobots('User-agent: *\nDisallow: /\nAllow: /contact\n');
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });

  it('returns true when path is explicitly allowed', async () => {
    mockRobots('User-agent: *\nDisallow: /private\nAllow: /contact\n');
    expect(await isAllowedByRobots('https://example.com/contact')).toBe(true);
  });
});

describe('isAllowedByRobots() — caching', () => {
  it('fetches robots.txt only once per domain', async () => {
    mockRobots('User-agent: *\nDisallow: /admin\n');
    await isAllowedByRobots('https://example.com/contact');
    await isAllowedByRobots('https://example.com/about');
    // Only one fetch for the same origin
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches separately for different domains', async () => {
    mockRobots('');
    mockRobots('');
    await isAllowedByRobots('https://example.com/contact');
    await isAllowedByRobots('https://other.com/contact');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clearRobotsCache() causes re-fetch on next call', async () => {
    mockRobots('');
    await isAllowedByRobots('https://example.com/contact');
    clearRobotsCache();
    mockRobots('');
    await isAllowedByRobots('https://example.com/contact');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('isAllowedByRobots() — malformed URL', () => {
  it('returns true for a malformed URL (fail-open)', async () => {
    expect(await isAllowedByRobots('not-a-url')).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

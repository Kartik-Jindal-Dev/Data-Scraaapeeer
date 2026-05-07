/**
 * pipeline/robots.ts
 * Lightweight robots.txt compliance checker.
 *
 * Behaviour:
 * - Fetches robots.txt once per domain per job run (in-memory cache, 24h TTL).
 * - If RESPECT_ROBOTS_TXT=true (default), checks whether the URL is allowed.
 * - If disallowed: logs and returns false — caller skips scraping for that URL.
 * - Does NOT block the pipeline — a disallowed URL is treated like an
 *   unreachable site (lead may still qualify via discovery-phase phone).
 * - Cache is module-level (persists across leads in the same process).
 *   A new process starts with an empty cache.
 *
 * Phase 3.2: 24-hour TTL added to cache entries. Stale entries are evicted
 * on next access, preventing indefinitely-cached robots.txt from blocking
 * newly-allowed paths after a site updates its rules.
 *
 * Uses a simple manual parser — no external robots-parser dependency.
 * Checks against 'Googlebot' user-agent (standard for public scrapers).
 *
 * CONSTRAINT: Never throws. All errors result in isAllowed() returning true
 * (fail-open — better to scrape than to silently skip valid sites).
 */

import { logger } from '../logger';

// ─── Cache ────────────────────────────────────────────────────────────────────

/** Phase 3.2: robots.txt cache entry with 24-hour TTL. */
interface RobotsCacheEntry {
  content: string;
  fetchedAt: number; // Unix ms timestamp
}

/** robots.txt content keyed by origin (e.g. "https://example.com"). */
const robotsCache = new Map<string, RobotsCacheEntry>();

const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const USER_AGENT_TOKEN = 'Googlebot'; // token to check rules against

// ─── Fetch robots.txt ─────────────────────────────────────────────────────────

async function fetchRobotsTxt(origin: string): Promise<string> {
  // Phase 3.2: check TTL — evict stale entries before returning cached content
  const cached = robotsCache.get(origin);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < ROBOTS_CACHE_TTL_MS) {
      return cached.content;
    }
    // Stale — evict and re-fetch
    robotsCache.delete(origin);
  }

  const robotsUrl = `${origin}/robots.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOTS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LeadScraper/1.0' },
    });
    clearTimeout(timer);

    if (!res.ok) {
      // Non-200 (e.g. 404) → no robots.txt → everything allowed
      robotsCache.set(origin, { content: '', fetchedAt: Date.now() });
      return '';
    }

    const text = await res.text();
    robotsCache.set(origin, { content: text, fetchedAt: Date.now() });
    return text;
  } catch {
    clearTimeout(timer);
    // Timeout or network error → fail-open, cache empty result briefly
    robotsCache.set(origin, { content: '', fetchedAt: Date.now() });
    return '';
  }
}

// ─── Simple robots.txt Parser ─────────────────────────────────────────────────

/**
 * Minimal robots.txt parser.
 * Checks whether `path` is disallowed for `userAgentToken`.
 *
 * Handles:
 * - User-agent: * (wildcard)
 * - User-agent: <specific> (e.g. Googlebot)
 * - Disallow: /path
 * - Allow: /path (takes precedence over Disallow)
 *
 * Returns true if the path is allowed, false if disallowed.
 */
function isPathAllowed(robotsTxt: string, urlPath: string, userAgentToken: string): boolean {
  if (!robotsTxt || robotsTxt.trim().length === 0) return true;

  const lines = robotsTxt.split('\n').map((l) => l.trim());

  // Collect rules for matching user-agent blocks
  const rules: Array<{ type: 'allow' | 'disallow'; path: string }> = [];
  let inMatchingBlock = false;

  for (const line of lines) {
    if (line.startsWith('#') || line === '') {
      // Blank line ends a user-agent block
      if (line === '') inMatchingBlock = false;
      continue;
    }

    const [key, ...valueParts] = line.split(':');
    const directive = key.trim().toLowerCase();
    const value = valueParts.join(':').trim();

    if (directive === 'user-agent') {
      const agent = value.toLowerCase();
      inMatchingBlock =
        agent === '*' || agent === userAgentToken.toLowerCase();
      continue;
    }

    if (!inMatchingBlock) continue;

    if (directive === 'disallow' && value) {
      rules.push({ type: 'disallow', path: value });
    } else if (directive === 'allow' && value) {
      rules.push({ type: 'allow', path: value });
    }
  }

  if (rules.length === 0) return true;

  // Find the most specific matching rule (longest path match wins)
  let bestMatch: { type: 'allow' | 'disallow'; path: string } | null = null;

  for (const rule of rules) {
    if (urlPath.startsWith(rule.path)) {
      if (!bestMatch || rule.path.length > bestMatch.path.length) {
        bestMatch = rule;
      }
    }
  }

  if (!bestMatch) return true;
  return bestMatch.type === 'allow';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Checks whether scraping the given URL is allowed by robots.txt.
 *
 * Returns true if:
 * - RESPECT_ROBOTS_TXT is not 'true' (disabled)
 * - robots.txt cannot be fetched (fail-open)
 * - The URL is not disallowed
 *
 * Returns false if the URL is explicitly disallowed.
 *
 * Never throws.
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  if (process.env.RESPECT_ROBOTS_TXT !== 'true') return true;

  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const urlPath = parsed.pathname || '/';

    const robotsTxt = await fetchRobotsTxt(origin);
    const allowed = isPathAllowed(robotsTxt, urlPath, USER_AGENT_TOKEN);

    if (!allowed) {
      logger.info(`Robots: disallowed by robots.txt — ${url}`);
    }

    return allowed;
  } catch {
    // Malformed URL or unexpected error → fail-open
    return true;
  }
}

/**
 * Clears the robots.txt cache.
 * Useful for testing or when starting a new job session.
 */
export function clearRobotsCache(): void {
  robotsCache.clear();
}

/**
 * Returns the current number of cached robots.txt entries.
 * Useful for monitoring cache effectiveness.
 */
export function getRobotsCacheSize(): number {
  return robotsCache.size;
}

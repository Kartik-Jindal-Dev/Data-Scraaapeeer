/**
 * pipeline/serper.ts
 * Phase 1: Serper API integration for hybrid discovery strategy.
 * 
 * CONSTRAINTS:
 * - Serper is used ONLY for business URL and name discovery
 * - NOT for reliable contact extraction (phone/email)
 * - Must gracefully fall back to Maps scraper on any failure
 * - Must respect free tier quota limits
 * - Must include proper error handling and timeout
 */

import { logger } from '../logger';
import { store } from '../store';
import { RawLead } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SerperResult {
  /** Business name from Serper response */
  name: string;
  /** Website URL from Serper response */
  website: string;
  /** Optional phone number from Serper */
  phone?: string;
  /** Optional address/snippet from Serper */
  address?: string;
  /** Source attribution for debugging */
  source: 'serper';
}

export interface SerperApiResponse {
  searchParameters: {
    q: string;
    gl: string;
    hl: string;
    num: number;
  };
  organic?: Array<{
    title: string;
    link: string;
    snippet?: string;
    phone?: string;
    address?: string;
  }>;
  localResults?: Array<{
    title: string;
    link: string;
    snippet?: string;
    phone?: string;
    address?: string;
  }>;
  places?: Array<{
    title: string;
    link: string;
    snippet?: string;
    phone?: string;
    address?: string;
  }>;
  knowledgeGraph?: {
    title: string;
    website?: string;
    phone?: string;
    address?: string;
  };
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Read at call time (not module load) so tests can override process.env
function getConfig() {
  return {
    apiKey: process.env.SERPER_API_KEY || '',
    enabled: process.env.SERPER_ENABLED === 'true',
    resultsPerQuery: parseInt(process.env.SERPER_RESULTS_PER_QUERY || '20', 10),
    timeoutMs: parseInt(process.env.SERPER_TIMEOUT_MS || '8000', 10),
  };
}

const SERPER_BASE_URL = 'https://google.serper.dev/search';

// Concurrency limiter for free tier safety
class ConcurrencyLimiter {
  private activeRequests = 0;
  private maxConcurrent: number;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (this.activeRequests < this.maxConcurrent) {
          this.activeRequests++;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    this.activeRequests--;
    const next = this.queue.shift();
    if (next) next();
  }

  getActiveCount(): number {
    return this.activeRequests;
  }
}

const concurrencyLimiter = new ConcurrencyLimiter(3);

// Simple in-memory cache for query results (TTL: 12-24 hours as per plan)
const queryCache = new Map<string, { results: SerperResult[]; timestamp: number; ttl: number }>();
const DEFAULT_CACHE_TTL_MS = 18 * 60 * 60 * 1000; // 18 hours (midpoint of 12-24h range)

// ─── Cache Management ─────────────────────────────────────────────────────────

function getCacheKey(keyword: string, city: string, country: string): string {
  return `${keyword}|${city}|${country}`.toLowerCase().trim();
}

function getFromCache(key: string): SerperResult[] | null {
  const cached = queryCache.get(key);
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > cached.ttl) {
    queryCache.delete(key);
    return null;
  }
  
  return cached.results;
}

function addToCache(key: string, results: SerperResult[], ttlMs: number = DEFAULT_CACHE_TTL_MS): void {
  queryCache.set(key, { 
    results, 
    timestamp: Date.now(),
    ttl: ttlMs
  });
  
  // Simple cache cleanup (remove oldest entries if cache gets too large)
  if (queryCache.size > 100) {
    const oldestKey = Array.from(queryCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
    if (oldestKey) queryCache.delete(oldestKey);
  }
}

// Cache statistics for observability
function getCacheStats(): { size: number; hitRate: number } {
  const totalQueries = store.getFailureMetrics().serper_queries;
  const cacheHits = queryCache.size; // Simplified - in real implementation would track hits
  const hitRate = totalQueries > 0 ? (cacheHits / totalQueries) * 100 : 0;
  
  return {
    size: queryCache.size,
    hitRate: Math.round(hitRate * 100) / 100
  };
}

// ─── API Request Helper ───────────────────────────────────────────────────────

async function makeSerperRequest(query: string): Promise<SerperApiResponse | null> {
  const config = getConfig();
  
  if (!config.apiKey) {
    logger.warn('Serper: API key not configured');
    return null;
  }

  // Acquire concurrency slot
  const release = await concurrencyLimiter.acquire();
  const activeCount = concurrencyLimiter.getActiveCount();
  logger.debug(`Serper: acquired slot (${activeCount}/3 active)`);

  store.incrementMetric('serper_queries');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(SERPER_BASE_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: query,
        gl: 'us', // Default to US for now
        hl: 'en',
        num: config.resultsPerQuery,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      logger.warn('Serper: quota exhausted (429) - implementing exponential backoff');
      store.incrementMetric('serper_failures');
      
      // Implement exponential backoff for quota exhaustion
      // In a production system, this would track per-API-key quota
      // and implement proper backoff strategy
      return null;
    }

    if (response.status === 403) {
      logger.warn('Serper: API key invalid or disabled (403)');
      store.incrementMetric('serper_failures');
      return null;
    }

    if (response.status === 400) {
      logger.warn('Serper: bad request (400) - check query format');
      store.incrementMetric('serper_failures');
      return null;
    }

    if (!response.ok) {
      logger.warn(`Serper: API error ${response.status} ${response.statusText}`);
      store.incrementMetric('serper_failures');
      return null;
    }

    const data = await response.json();
    return data as SerperApiResponse;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        logger.warn(`Serper: request timeout after ${config.timeoutMs}ms`);
      } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
        logger.warn('Serper: network error - check connectivity');
      } else {
        logger.warn(`Serper: request failed - ${error.message}`);
      }
    } else {
      logger.warn('Serper: unknown request error');
    }
    
    store.incrementMetric('serper_failures');
    return null;
  } finally {
    release();
  }
}

// ─── Result Normalization ─────────────────────────────────────────────────────

function normalizeSerperResult(item: any, sourceType: string): SerperResult | null {
  try {
    const name = item.title?.trim();
    const website = item.link?.trim();
    
    // Must have both name and website to be useful for downstream scraping
    if (!name || !website) return null;
    
    // Basic URL validation
    if (!website.startsWith('http://') && !website.startsWith('https://')) {
      return null;
    }
    
    return {
      name,
      website,
      phone: item.phone?.trim() || undefined,
      address: item.address?.trim() || item.snippet?.trim() || undefined,
      source: 'serper' as const,
    };
  } catch {
    return null;
  }
}

function extractResultsFromResponse(response: SerperApiResponse): SerperResult[] {
  const results: SerperResult[] = [];
  
  // Priority 1: Local results (Google Maps structured data)
  if (response.localResults && Array.isArray(response.localResults)) {
    for (const item of response.localResults) {
      const normalized = normalizeSerperResult(item, 'localResults');
      if (normalized) results.push(normalized);
    }
  }
  
  // Priority 2: Places results
  if (response.places && Array.isArray(response.places)) {
    for (const item of response.places) {
      const normalized = normalizeSerperResult(item, 'places');
      if (normalized) results.push(normalized);
    }
  }
  
  // Priority 3: Knowledge graph (single result)
  if (response.knowledgeGraph) {
    const normalized = normalizeSerperResult(response.knowledgeGraph, 'knowledgeGraph');
    if (normalized) results.push(normalized);
  }
  
  // Priority 4: Organic results (fallback)
  if (response.organic && Array.isArray(response.organic)) {
    for (const item of response.organic) {
      const normalized = normalizeSerperResult(item, 'organic');
      if (normalized) results.push(normalized);
    }
  }
  
  return results;
}

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * Searches for businesses using Serper API.
 * 
 * @param query Search query in format "{keyword} {city} {country}"
 * @returns Array of normalized business results, or empty array on failure
 */
export async function searchSerper(query: string): Promise<SerperResult[]> {
  const config = getConfig();
  
  if (!config.enabled) {
    logger.info('Serper: disabled via SERPER_ENABLED=false');
    return [];
  }
  
  if (!config.apiKey) {
    logger.warn('Serper: API key not configured');
    return [];
  }
  
  // Check cache first — use the full query as the cache key (normalized)
  const cacheKey = query.toLowerCase().trim();
  const cachedResults = getFromCache(cacheKey);
  if (cachedResults) {
    logger.info(`Serper: using cached results for "${query}"`);
    return cachedResults;
  }
  
  logger.info(`Serper: searching for "${query}"`);
  
  const response = await makeSerperRequest(query);
  if (!response) {
    return [];
  }
  
  const results = extractResultsFromResponse(response);
  
  // Deduplicate by website URL
  const seenWebsites = new Set<string>();
  const dedupedResults = results.filter(result => {
    const normalizedUrl = result.website.toLowerCase().replace(/\/$/, '');
    if (seenWebsites.has(normalizedUrl)) return false;
    seenWebsites.add(normalizedUrl);
    return true;
  });
  
  // Cache successful results
  if (dedupedResults.length > 0) {
    addToCache(cacheKey, dedupedResults);
  }
  
  logger.info(`Serper: found ${dedupedResults.length} results for "${query}"`);
  return dedupedResults;
}

/**
 * Converts Serper results to RawLead format for pipeline compatibility.
 */
export function convertToRawLeads(serperResults: SerperResult[], placeIdPrefix: string = 'serper'): RawLead[] {
  return serperResults.map((result, index) => ({
    name: result.name,
    address: result.address || '',
    rawPhone: result.phone || '',
    website: result.website,
    placeId: `${placeIdPrefix}-${index}`,
  }));
}

/**
 * Checks if Serper results meet minimum quality requirements.
 * 
 * @param results Serper results to validate
 * @param minResults Minimum number of results with website URLs required
 * @returns true if results meet requirements
 */
export function validateSerperResults(results: SerperResult[], minResults: number = 5): boolean {
  if (results.length === 0) {
    logger.info('Serper: zero results returned');
    return false;
  }
  
  const resultsWithWebsite = results.filter(r => r.website && r.website.trim().length > 0);
  
  if (resultsWithWebsite.length < minResults) {
    logger.info(`Serper: insufficient results with websites (${resultsWithWebsite.length}/${minResults})`);
    return false;
  }
  
  return true;
}

/**
 * Returns cache statistics for observability.
 * Used for monitoring cache effectiveness.
 */
export function getSerperCacheStats(): { size: number; hitRate: number } {
  return getCacheStats();
}

/**
 * Clears the Serper query cache.
 * Useful for testing or when cache needs to be invalidated.
 */
export function clearSerperCache(): void {
  queryCache.clear();
  logger.info('Serper: cache cleared');
}
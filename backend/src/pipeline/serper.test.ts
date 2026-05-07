/**
 * serper.test.ts
 * Unit tests for Serper API integration (Phase 1).
 *
 * Tests cover:
 * - Result normalization from different Serper response formats
 * - Fallback conditions and validation logic
 * - Cache behavior and TTL management
 * - Error handling for various API failure modes
 * - Source attribution (source: 'serper')
 * - URL deduplication
 */

import {
  searchSerper,
  convertToRawLeads,
  validateSerperResults,
  clearSerperCache,
  getSerperCacheStats,
  SerperResult,
} from './serper';
import { store } from '../store';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../store', () => ({
  store: {
    incrementMetric: jest.fn(),
    getFailureMetrics: jest.fn(() => ({
      serper_queries: 0,
      serper_failures: 0,
      serper_fallbacks: 0,
      serper_results_used: 0,
    })),
  },
}));

// ─── Test Data ────────────────────────────────────────────────────────────────

const mockLocalResults = [
  {
    title: 'ABC Plumbing Services',
    link: 'https://abcplumbing.com',
    phone: '+1-555-0100',
    address: '123 Main St, Houston, TX',
  },
  {
    title: 'XYZ Plumbers',
    link: 'https://xyzplumbers.com',
    snippet: '456 Oak Ave, Houston, TX',
  },
];

const mockPlacesResults = [
  {
    title: 'Best Plumbing Co',
    link: 'https://bestplumbing.com',
    phone: '+1-555-0200',
    address: '789 Pine Rd, Houston, TX',
  },
];

const mockOrganicResults = [
  {
    title: 'Houston Plumbing Directory',
    link: 'https://directory.com/plumbing',
    snippet: 'Find plumbers in Houston',
  },
];

const mockSerperResponse = {
  searchParameters: {
    q: 'plumber Houston USA',
    gl: 'us',
    hl: 'en',
    num: 20,
  },
  localResults: mockLocalResults,
  places: mockPlacesResults,
  organic: mockOrganicResults,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetchOk(body: object) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response);
}

function mockFetchError(status: number, statusText: string) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    statusText,
    json: async () => ({}),
  } as unknown as Response);
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  clearSerperCache();

  process.env.SERPER_ENABLED = 'true';
  process.env.SERPER_API_KEY = 'test-api-key';
  process.env.SERPER_RESULTS_PER_QUERY = '20';
  process.env.SERPER_TIMEOUT_MS = '8000';

  // Default fetch mock — overridden per test as needed
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => mockSerperResponse,
  } as unknown as Response);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── convertToRawLeads ────────────────────────────────────────────────────────

describe('convertToRawLeads()', () => {
  it('maps all fields correctly', () => {
    const serperResults: SerperResult[] = [
      {
        name: 'ABC Plumbing',
        website: 'https://abcplumbing.com',
        phone: '+1-555-0100',
        address: '123 Main St',
        source: 'serper',
      },
    ];

    const rawLeads = convertToRawLeads(serperResults, 'test');

    expect(rawLeads).toHaveLength(1);
    expect(rawLeads[0]).toEqual({
      name: 'ABC Plumbing',
      address: '123 Main St',
      rawPhone: '+1-555-0100',
      website: 'https://abcplumbing.com',
      placeId: 'test-0',
    });
  });

  it('uses empty strings for missing optional fields', () => {
    const serperResults: SerperResult[] = [
      { name: 'Test Business', website: 'https://test.com', source: 'serper' },
    ];

    const rawLeads = convertToRawLeads(serperResults);

    expect(rawLeads[0].rawPhone).toBe('');
    expect(rawLeads[0].address).toBe('');
    expect(rawLeads[0].placeId).toBe('serper-0');
  });

  it('generates sequential placeIds', () => {
    const serperResults: SerperResult[] = [
      { name: 'A', website: 'https://a.com', source: 'serper' },
      { name: 'B', website: 'https://b.com', source: 'serper' },
      { name: 'C', website: 'https://c.com', source: 'serper' },
    ];

    const rawLeads = convertToRawLeads(serperResults, 'prefix');

    expect(rawLeads[0].placeId).toBe('prefix-0');
    expect(rawLeads[1].placeId).toBe('prefix-1');
    expect(rawLeads[2].placeId).toBe('prefix-2');
  });
});

// ─── validateSerperResults ────────────────────────────────────────────────────

describe('validateSerperResults()', () => {
  it('returns true when results meet minimum threshold', () => {
    const results: SerperResult[] = [
      { name: 'A', website: 'https://a.com', source: 'serper' },
      { name: 'B', website: 'https://b.com', source: 'serper' },
      { name: 'C', website: 'https://c.com', source: 'serper' },
      { name: 'D', website: 'https://d.com', source: 'serper' },
      { name: 'E', website: 'https://e.com', source: 'serper' },
    ];

    expect(validateSerperResults(results, 5)).toBe(true);
  });

  it('returns false for empty results array', () => {
    expect(validateSerperResults([], 5)).toBe(false);
  });

  it('returns false when fewer results have websites than minimum', () => {
    const results: SerperResult[] = [
      { name: 'A', website: 'https://a.com', source: 'serper' },
      { name: 'B', website: 'https://b.com', source: 'serper' },
      { name: 'C', website: '', source: 'serper' },
      { name: 'D', website: '', source: 'serper' },
    ];

    expect(validateSerperResults(results, 5)).toBe(false);
  });

  it('ignores whitespace-only website strings', () => {
    const results: SerperResult[] = [
      { name: 'A', website: 'https://a.com', source: 'serper' },
      { name: 'B', website: '   ', source: 'serper' },
    ];

    expect(validateSerperResults(results, 2)).toBe(false);
    expect(validateSerperResults(results, 1)).toBe(true);
  });

  it('uses default minimum of 5 when not specified', () => {
    const results: SerperResult[] = [
      { name: 'A', website: 'https://a.com', source: 'serper' },
    ];

    expect(validateSerperResults(results)).toBe(false);
  });
});

// ─── searchSerper — disabled / missing key ────────────────────────────────────

describe('searchSerper() — disabled or unconfigured', () => {
  it('returns empty array when SERPER_ENABLED=false', async () => {
    process.env.SERPER_ENABLED = 'false';

    const results = await searchSerper('plumber Houston USA');

    expect(results).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns empty array when API key is missing', async () => {
    process.env.SERPER_API_KEY = '';

    const results = await searchSerper('plumber Houston USA');

    expect(results).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ─── searchSerper — result priority ──────────────────────────────────────────

describe('searchSerper() — result priority', () => {
  it('returns localResults first', async () => {
    mockFetchOk(mockSerperResponse);

    const results = await searchSerper('plumber Houston USA');

    expect(results[0].name).toBe('ABC Plumbing Services');
    expect(results[1].name).toBe('XYZ Plumbers');
  });

  it('includes places results after localResults', async () => {
    mockFetchOk(mockSerperResponse);

    const results = await searchSerper('plumber Houston USA');

    const placesResult = results.find(r => r.name === 'Best Plumbing Co');
    expect(placesResult).toBeDefined();
  });

  it('falls back to organic when no local/places results', async () => {
    mockFetchOk({
      searchParameters: mockSerperResponse.searchParameters,
      organic: mockOrganicResults,
    });

    const results = await searchSerper('plumber Houston USA');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('Houston Plumbing Directory');
  });

  it('returns empty array when response has no results sections', async () => {
    mockFetchOk({ searchParameters: mockSerperResponse.searchParameters });

    const results = await searchSerper('plumber Houston USA');

    expect(results).toEqual([]);
  });
});

// ─── searchSerper — source attribution ───────────────────────────────────────

describe('searchSerper() — source attribution', () => {
  it('sets source: "serper" on all results', async () => {
    mockFetchOk(mockSerperResponse);

    const results = await searchSerper('plumber Houston USA');

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.source).toBe('serper');
    }
  });
});

// ─── searchSerper — URL validation ───────────────────────────────────────────

describe('searchSerper() — URL validation', () => {
  it('filters out results without http/https URLs', async () => {
    mockFetchOk({
      searchParameters: mockSerperResponse.searchParameters,
      localResults: [
        { title: 'Valid', link: 'https://valid.com' },
        { title: 'Invalid JS', link: 'javascript:void(0)' },
        { title: 'Invalid FTP', link: 'ftp://files.com' },
      ],
    });

    const results = await searchSerper('test query');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Valid');
  });

  it('filters out results with missing name or website', async () => {
    mockFetchOk({
      searchParameters: mockSerperResponse.searchParameters,
      localResults: [
        { title: 'Complete', link: 'https://complete.com' },
        { title: '', link: 'https://noname.com' },
        { title: 'No Website', link: '' },
      ],
    });

    const results = await searchSerper('test query');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Complete');
  });
});

// ─── searchSerper — deduplication ────────────────────────────────────────────

describe('searchSerper() — URL deduplication', () => {
  it('deduplicates results with identical URLs', async () => {
    mockFetchOk({
      searchParameters: mockSerperResponse.searchParameters,
      localResults: [
        { title: 'ABC Plumbing', link: 'https://abcplumbing.com' },
        { title: 'ABC Plumbing Services', link: 'https://abcplumbing.com/' }, // trailing slash
      ],
    });

    const results = await searchSerper('test query');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('ABC Plumbing');
  });

  it('deduplicates case-insensitive URLs', async () => {
    mockFetchOk({
      searchParameters: mockSerperResponse.searchParameters,
      localResults: [
        { title: 'ABC Plumbing', link: 'https://abcplumbing.com' },
        { title: 'ABC Plumbing Services', link: 'HTTPS://ABCPLUMBING.COM/' },
      ],
    });

    const results = await searchSerper('test query');

    expect(results).toHaveLength(1);
  });
});

// ─── searchSerper — caching ───────────────────────────────────────────────────

describe('searchSerper() — caching', () => {
  it('returns cached results on second call without hitting API', async () => {
    const query = 'plumber Houston USA';

    const results1 = await searchSerper(query);
    const results2 = await searchSerper(query);

    expect(global.fetch).toHaveBeenCalledTimes(1); // Only one API call
    expect(results2).toEqual(results1);
  });

  it('makes a new API call after cache is cleared', async () => {
    const query = 'plumber Houston USA';

    await searchSerper(query);
    clearSerperCache();
    await searchSerper(query);

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports cache size via getSerperCacheStats', async () => {
    clearSerperCache();
    expect(getSerperCacheStats().size).toBe(0);

    await searchSerper('plumber Houston USA');
    expect(getSerperCacheStats().size).toBe(1);

    // Second distinct query — needs a fresh mock response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => mockSerperResponse,
    } as unknown as Response);
    await searchSerper('dentist Dallas USA');
    expect(getSerperCacheStats().size).toBe(2);
  });

  it('does not cache empty results', async () => {
    mockFetchOk({ searchParameters: mockSerperResponse.searchParameters });

    await searchSerper('empty query');

    expect(getSerperCacheStats().size).toBe(0);
  });
});

// ─── searchSerper — error handling ───────────────────────────────────────────

describe('searchSerper() — error handling', () => {
  it('handles 429 quota exhaustion gracefully', async () => {
    mockFetchError(429, 'Too Many Requests');

    const results = await searchSerper('test query');

    expect(results).toEqual([]);
    expect(store.incrementMetric).toHaveBeenCalledWith('serper_failures');
  });

  it('handles 403 forbidden gracefully', async () => {
    mockFetchError(403, 'Forbidden');

    const results = await searchSerper('test query');

    expect(results).toEqual([]);
    expect(store.incrementMetric).toHaveBeenCalledWith('serper_failures');
  });

  it('handles 400 bad request gracefully', async () => {
    mockFetchError(400, 'Bad Request');

    const results = await searchSerper('test query');

    expect(results).toEqual([]);
    expect(store.incrementMetric).toHaveBeenCalledWith('serper_failures');
  });

  it('handles network errors gracefully', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('fetch failed'));

    const results = await searchSerper('test query');

    expect(results).toEqual([]);
    expect(store.incrementMetric).toHaveBeenCalledWith('serper_failures');
  });

  it('handles malformed JSON response gracefully', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new Error('Invalid JSON'); },
    } as unknown as Response);

    const results = await searchSerper('test query');

    expect(results).toEqual([]);
    expect(store.incrementMetric).toHaveBeenCalledWith('serper_failures');
  });

  it('increments serper_queries metric on each API call', async () => {
    mockFetchOk(mockSerperResponse);

    await searchSerper('test query');

    expect(store.incrementMetric).toHaveBeenCalledWith('serper_queries');
  });
});

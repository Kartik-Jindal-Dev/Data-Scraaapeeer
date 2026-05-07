/**
 * types.ts
 * Central type definitions for the Lead Generation Scraper.
 * These types are the single source of truth for all data shapes.
 *
 * CONSTRAINTS:
 * - _hasBoth and _qualityTier are INTERNAL ONLY — never exported to Excel or SSE payloads
 * - phone must always be E.164 format or empty string
 * - email must always be scraped — never guessed or generated
 */

// ─── Quality Tier ─────────────────────────────────────────────────────────────

/** Internal classification of lead contact completeness. Never exported. */
export type QualityTier = 'Tier1' | 'Tier2' | 'Tier3';

// ─── Job Status ───────────────────────────────────────────────────────────────

/** Lifecycle states of a scrape job. */
export type JobStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';

// ─── Scrape Depth ─────────────────────────────────────────────────────────────

/** Controls how deep website scraping goes per business. */
export type ScrapeDepth = 'homepage' | 'indepth';

// ─── Contact Filter ───────────────────────────────────────────────────────────

/**
 * Controls which leads are kept after scraping.
 *
 * any        — keep if email OR phone present (default, original behaviour)
 * email_only — keep only if email is present (phone optional)
 * phone_only — keep only if phone is present (email optional)
 * both       — keep only if BOTH email AND phone are present
 */
export type ContactFilter = 'any' | 'email_only' | 'phone_only' | 'both';

// ─── Lead ─────────────────────────────────────────────────────────────────────

/**
 * A qualifying business record with at least one contact method.
 * Internal fields (_hasBoth, _qualityTier) must never appear in exports or SSE payloads.
 */
export interface Lead {
  /** Business name — always present, sourced from discovery. */
  businessName: string;

  /** Scraped email address. Empty string if not found. NEVER guessed. */
  email: string;

  /** Phone in E.164 format (e.g. +919876543210). Empty string if not found. */
  phone: string;

  /** Full website URL with https://. Empty string if not found. */
  website: string;

  /** Formatted address — always present, sourced from discovery. */
  address: string;

  /** Internal sort key: true if both email AND phone are present. NOT exported. */
  _hasBoth: boolean;

  /** Internal quality classification. NOT exported. NOT in SSE payloads. */
  _qualityTier: QualityTier;

  /**
   * True if a contact form was detected on the website but no email was scraped.
   * Informational only — never used for filtering. NOT a constraint violation.
   */
  hasContactForm?: boolean;

  /**
   * True if the email is a generic role address (info@, contact@, support@, etc.).
   * Flagged for outreach teams — lower reply rate than personal addresses.
   */
  isGenericEmail?: boolean;

  /**
   * True if the email is from a freemail provider (gmail.com, yahoo.com, etc.).
   * Kept only when no company-domain email exists.
   */
  isFreeEmail?: boolean;

  /**
   * True if the email is from a relay/platform domain or uses a "+" alias
   * on a non-business, non-freemail domain.
   * Indicates higher bounce risk.
   */
  isRelayEmail?: boolean;
}

/**
 * Public-facing lead fields safe to include in SSE `lead` events.
 * Strips all internal fields.
 */
export type PublicLead = Omit<Lead, '_hasBoth' | '_qualityTier'>;

// ─── Raw Lead ─────────────────────────────────────────────────────────────────

/**
 * A business record returned by the Discovery_Module before filtering.
 * May have no phone and no website URL — kept regardless (constraint: filter runs post-scrape only).
 */
export interface RawLead {
  /** Business name from discovery source. */
  name: string;

  /** Formatted address from discovery source. */
  address: string;

  /** Raw phone string from discovery source. May be empty. Not yet normalised. */
  rawPhone: string;

  /** Website URL from discovery source. May be empty. */
  website: string;

  /** Place ID from Outscraper (for debug/logging). May be empty for Maps fallback. */
  placeId: string;
}

// ─── Failure Metrics ──────────────────────────────────────────────────────────

/**
 * Counters for pipeline failure conditions.
 * Exposed via GET /api/status. Reset on store.reset().
 */
export interface FailureMetrics {
  /** Leads discarded because both email and phone were empty after all scraping. */
  discard_no_contact: number;

  /** Business websites that returned 4xx/5xx, timed out, or redirected to login. */
  website_unreachable: number;

  /** Leads where no email survived extraction and filtering. */
  email_not_found: number;

  /** Leads where no valid phone number was found or normalised. */
  phone_not_found: number;

  /** Raw leads skipped by the Deduplicator (key already seen in this run). */
  duplicate_skipped: number;

  /** Website scraping requests blocked by CAPTCHA. */
  captcha_blocked: number;

  /** Sub-pages successfully scraped during in-depth crawl (depth=indepth). */
  subpages_scraped: number;

  /** Phase 1: Serper API metrics */
  serper_queries: number;
  serper_failures: number;
  serper_fallbacks: number;
  serper_results_used: number;
}

// ─── Job Context ──────────────────────────────────────────────────────────────

/**
 * Runtime context for a single scrape job.
 * Created on POST /api/start, cleared on store.reset().
 */
export interface JobContext {
  /** Unique job identifier (UUID v4). */
  jobId: string;

  /** Search keyword — exactly 1 per run (e.g. "plumber"). */
  keyword: string;

  /** Location string used for the current city query (e.g. "Houston, TX"). */
  location: string;

  /** Scraping depth setting. */
  depth: ScrapeDepth;

  /**
   * ISO 3166-1 alpha-2 country code extracted from the Geocoder response.
   * Used as defaultRegion for libphonenumber-js throughout the run.
   * e.g. "IN", "US", "GB"
   */
  isoCountryCode: string;

  /**
   * Contact filter mode chosen by the operator.
   * Determines which leads pass the post-scrape filter.
   * Defaults to 'any' (original behaviour — email OR phone).
   */
  contactFilter: ContactFilter;

  /**
   * Maximum number of leads to collect before stopping.
   * The job queue / controller stops dispatching new city jobs once this is reached.
   * Defaults to MAX_LEADS env var (fallback: 100).
   */
  maxLeads: number;
}

// ─── City Pool (Phase 12 — Location Engine) ──────────────────────────────────

/**
 * A single city entry in the city pool.
 * Sourced from the static base or fetched from Nominatim (fallback).
 */
export interface CityEntry {
  /** City name (e.g. "Houston", "Mumbai"). */
  name: string;
  /** State/region name (e.g. "Texas", "Maharashtra"). */
  state: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "US", "IN"). Populated for all entries. */
  country?: string;
  /** Latitude — populated for Nominatim-sourced entries. */
  lat?: number;
  /** Longitude — populated for Nominatim-sourced entries. */
  lon?: number;
  /** Nominatim importance score (0–1). Higher = more significant city. */
  importance?: number;
  /** Where this entry came from. */
  source: 'static' | 'nominatim';
}

/**
 * A resolved city pool for one state.
 * Built once per state at session start; cities sorted by population descending.
 */
export interface CityPool {
  /** US state abbreviation (e.g. "TX"). */
  state: string;
  /** Ordered list of cities — largest first. */
  cities: CityEntry[];
  /** Unix timestamp (ms) when this pool was built. */
  fetchedAt: number;
}

// ─── Store Stats ──────────────────────────────────────────────────────────────

/** Snapshot of current job statistics. Returned by GET /api/status. */
export interface StoreStats {
  leadCount: number;
  discardCount: number;
  jobStatus: JobStatus;
  failureMetrics: FailureMetrics;
  jobContext: JobContext | null;
}

// ─── SSE Event Payloads ───────────────────────────────────────────────────────

/** Payload for SSE `lead` events. Public fields only — no internal fields. */
export interface SseLeadPayload extends PublicLead {}

/** Payload for SSE `discard` events. */
export interface SseDiscardPayload {
  total: number;
  leadCount: number;
  jobStatus: JobStatus;
}

/** Payload for SSE `status` events. */
export interface SseStatusPayload {
  status: JobStatus;
  leadCount: number;
  discardCount: number;
  /** Active keyword for the current pipeline run. Omitted on final/terminal events. */
  activeKeyword?: string;
  /** Active location for the current pipeline run. Omitted on final/terminal events. */
  activeLocation?: string;
  /** Phase 14 — City batching progress. Present only during city-batched runs. */
  batchProgress?: {
    /** Current batch number (1-based). */
    currentBatch: number;
    /** Total number of batches. */
    totalBatches: number;
    /** Number of cities processed so far. */
    citiesProcessed: number;
    /** Total cities in the pool. */
    totalCities: number;
  };
  /**
   * Phase 6 — Round-robin scheduler progress.
   * Present only when CITY_ROUND_ROBIN_ENABLED=true.
   * Provides per-selection progress and exhaustion state.
   */
  roundRobinProgress?: {
    /** Current round number (1-based). */
    currentRound: number;
    /** Per-selection progress. Order matches the original selections array. */
    selections: Array<{
      /** Selection name (e.g. "Gujarat", "Texas"). */
      name: string;
      /** Number of valid cities yielded from this selection so far. */
      citiesYielded: number;
      /** Total cities available in this selection's ranked list. */
      totalCities: number;
      /** True if this selection is exhausted (cursor reached end). */
      exhausted: boolean;
    }>;
  };
}

/** Payload for SSE `error` events. */
export interface SseErrorPayload {
  message: string;
}

/** Union of all SSE event types. */
export type SseEventType = 'lead' | 'discard' | 'status' | 'error';

export interface SseEvent {
  event: SseEventType;
  data: SseLeadPayload | SseDiscardPayload | SseStatusPayload | SseErrorPayload;
}

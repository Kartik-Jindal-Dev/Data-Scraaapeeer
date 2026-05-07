/**
 * types.ts
 * Frontend type definitions — mirrors the backend's public-facing shapes.
 * Internal fields (_hasBoth, _qualityTier) are never present here.
 */

export type JobStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';
export type ScrapeDepth = 'homepage' | 'indepth';
export type ContactFilter = 'any' | 'email_only' | 'phone_only' | 'both';

// ─── Phase 13 — Profession → Keyword mapping ─────────────────────────────────

/**
 * Maps a human-readable profession label to the single search keyword
 * sent to the backend. Exactly 1 keyword per run.
 */
export const PROFESSIONS: Record<string, string> = {
  'Plumber':              'plumber',
  'Electrician':          'electrician',
  'HVAC Technician':      'HVAC',
  'Dentist':              'dentist',
  'Real Estate Agent':    'real estate agent',
  'Lawyer':               'lawyer',
  'Accountant':           'accountant',
  'Contractor':           'contractor',
  'Roofer':               'roofer',
  'Pest Control':         'pest control',
  'Landscaper':           'landscaper',
  'Painter':              'painter',
  'Locksmith':            'locksmith',
  'Auto Mechanic':        'auto mechanic',
  'Chiropractor':         'chiropractor',
  'Physiotherapist':      'physiotherapist',
  'Veterinarian':         'veterinarian',
  'Insurance Agent':      'insurance agent',
  'Financial Advisor':    'financial advisor',
  'Digital Marketing':    'digital marketing agency',
  'Web Designer':         'web designer',
  'IT Support':           'IT support',
  'Cleaning Service':     'cleaning service',
  'Moving Company':       'moving company',
  'Catering':             'catering',
  'Photography':          'photographer',
  'Tutoring':             'tutor',
  'Gym / Fitness':        'gym',
  'Spa / Salon':          'spa',
  'Restaurant':           'restaurant',
};

/** Sorted list of profession labels for the dropdown. */
export const PROFESSION_LABELS = Object.keys(PROFESSIONS).sort();

// ─── Lead ─────────────────────────────────────────────────────────────────────

/** Public lead as received from SSE `lead` events. */
export interface Lead {
  businessName: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  hasContactForm?: boolean;
  isGenericEmail?: boolean;
  isFreeEmail?: boolean;
  isRelayEmail?: boolean;
}

/** Payload of SSE `discard` events. */
export interface DiscardPayload {
  total: number;
  leadCount: number;
  jobStatus: JobStatus;
}

/** Payload of SSE `status` events. */
export interface StatusPayload {
  status: JobStatus;
  leadCount: number;
  discardCount: number;
  activeKeyword?: string;
  activeLocation?: string;
  /** Phase 14 — City batching progress. Present only during city-batched runs. */
  batchProgress?: {
    currentBatch: number;
    totalBatches: number;
    citiesProcessed: number;
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

/** Payload of SSE `error` events. */
export interface ErrorPayload {
  message: string;
}


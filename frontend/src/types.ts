/**
 * types.ts
 * Frontend type definitions — mirrors the backend's public-facing shapes.
 * Internal fields (_hasBoth, _qualityTier) are never present here.
 */

export type JobStatus = 'idle' | 'running' | 'stopped' | 'completed' | 'error';
export type ScrapeDepth = 'homepage' | 'indepth';

/** Public lead as received from SSE `lead` events. */
export interface Lead {
  businessName: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  hasContactForm?: boolean;
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
}

/** Payload of SSE `error` events. */
export interface ErrorPayload {
  message: string;
}

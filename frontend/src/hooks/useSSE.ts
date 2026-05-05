'use client';

import { useEffect, useRef } from 'react';
import {
  Lead,
  DiscardPayload,
  StatusPayload,
  ErrorPayload,
  JobStatus,
} from '../types';

interface SSEHandlers {
  onLead: (lead: Lead) => void;
  onDiscard: (payload: DiscardPayload) => void;
  onStatus: (payload: StatusPayload) => void;
  onError: (payload: ErrorPayload) => void;
}

/**
 * Opens an EventSource connection to /api/stream?jobId=<id>.
 * Automatically closes when jobId becomes null or the component unmounts.
 * Closes on terminal status events (completed, stopped, error).
 */
export function useSSE(jobId: string | null, handlers: SSEHandlers): void {
  // Keep handlers in a ref so the effect doesn't re-run when they change
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/stream?jobId=${encodeURIComponent(jobId)}`);

    es.addEventListener('lead', (e: MessageEvent) => {
      try {
        handlersRef.current.onLead(JSON.parse(e.data) as Lead);
      } catch {
        // Ignore malformed events
      }
    });

    es.addEventListener('discard', (e: MessageEvent) => {
      try {
        handlersRef.current.onDiscard(JSON.parse(e.data) as DiscardPayload);
      } catch {}
    });

    es.addEventListener('status', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as StatusPayload;
        handlersRef.current.onStatus(payload);
        // Close on terminal states
        const terminal: JobStatus[] = ['completed', 'stopped', 'error'];
        if (terminal.includes(payload.status)) {
          es.close();
        }
      } catch {}
    });

    es.addEventListener('error', (e: MessageEvent) => {
      try {
        handlersRef.current.onError(JSON.parse(e.data) as ErrorPayload);
      } catch {}
    });

    return () => {
      es.close();
    };
  }, [jobId]);
}

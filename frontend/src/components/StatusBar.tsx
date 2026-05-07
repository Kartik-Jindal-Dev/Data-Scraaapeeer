'use client';

import { useEffect, useRef, useState } from 'react';
import { JobStatus, StatusPayload } from '../types';

interface StatusBarProps {
  status: JobStatus;
  leadCount: number;
  discardCount: number;
  errorMessage: string;
  activeKeyword?: string;
  activeLocation?: string;
  /** Phase 14 — batch progress from city-batched runs. */
  batchProgress?: StatusPayload['batchProgress'];
  /**
   * Phase 6 — round-robin scheduler progress.
   * Present only when CITY_ROUND_ROBIN_ENABLED=true.
   */
  roundRobinProgress?: StatusPayload['roundRobinProgress'];
  /** Max leads target — shown alongside lead count when set. */
  maxLeads?: number;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  completed: 'Completed',
  error: 'Error',
};

const STATUS_COLORS: Record<JobStatus, string> = {
  idle: 'bg-gray-100 text-gray-600',
  running: 'bg-blue-100 text-blue-700',
  stopped: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
};

/** Formats elapsed milliseconds as "1m 23s" or "45s". */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default function StatusBar({
  status,
  leadCount,
  discardCount,
  errorMessage,
  activeKeyword,
  activeLocation,
  batchProgress,
  roundRobinProgress,
  maxLeads,
}: StatusBarProps) {
  // ── Elapsed time ────────────────────────────────────────────────────────────
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === 'running') {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
        setElapsedMs(0);
      }
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - (startTimeRef.current ?? Date.now()));
      }, 1000);
    } else if (status === 'idle') {
      startTimeRef.current = null;
      setElapsedMs(0);
      if (timerRef.current) clearInterval(timerRef.current);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  const showElapsed = status !== 'idle' && elapsedMs > 0;

  // ── Batch progress bar percentage ─────────────────────────────────────────
  const batchPct = batchProgress && batchProgress.totalCities > 0
    ? Math.round((batchProgress.citiesProcessed / batchProgress.totalCities) * 100)
    : null;

  // ── Lead progress percentage ──────────────────────────────────────────────
  const leadPct = maxLeads && maxLeads > 0
    ? Math.min(100, Math.round((leadCount / maxLeads) * 100))
    : null;

  return (
    <div
      className={`rounded-lg text-sm ${STATUS_COLORS[status]}`}
      role="status"
      aria-live="polite"
      aria-label={`Job status: ${STATUS_LABELS[status]}`}
    >
      {/* ── Main row ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 px-4 py-3">
        {/* Status badge */}
        <span className="font-semibold">{STATUS_LABELS[status]}</span>

        {/* Lead count */}
        <span>
          <span className="font-medium">{leadCount}</span>
          {maxLeads ? (
            <span className="opacity-75"> / {maxLeads} leads</span>
          ) : (
            <span> {leadCount === 1 ? 'lead' : 'leads'} found</span>
          )}
        </span>

        {/* Discard count */}
        {discardCount > 0 && (
          <span className="opacity-75">{discardCount} discarded</span>
        )}

        {/* Batch progress */}
        {status === 'running' && batchProgress && (
          <span
            className="opacity-75 text-xs font-mono bg-blue-200 text-blue-800 px-2 py-0.5 rounded"
            aria-label={`Batch ${batchProgress.currentBatch} of ${batchProgress.totalBatches}, city ${batchProgress.citiesProcessed + 1} of ${batchProgress.totalCities}`}
          >
            Batch {batchProgress.currentBatch}/{batchProgress.totalBatches} · City {batchProgress.citiesProcessed + 1}/{batchProgress.totalCities}
          </span>
        )}

        {/* Active keyword + location */}
        {status === 'running' && (activeKeyword || activeLocation) && (
          <span
            className="opacity-75 text-xs font-mono bg-blue-200 text-blue-800 px-2 py-0.5 rounded"
            aria-label={`Scanning: ${activeKeyword} in ${activeLocation}`}
          >
            🔍 {activeKeyword}{activeKeyword && activeLocation ? ' · ' : ''}{activeLocation}
          </span>
        )}

        {/* Elapsed time */}
        {showElapsed && (
          <span className="opacity-75" aria-label={`Time elapsed: ${formatElapsed(elapsedMs)}`}>
            ⏱ {formatElapsed(elapsedMs)}
          </span>
        )}

        {/* Running spinner */}
        {status === 'running' && (
          <span
            className="inline-block w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
        )}

        {/* Error message */}
        {errorMessage && (
          <span className="text-red-600 font-medium" role="alert">
            ⚠ {errorMessage}
          </span>
        )}
      </div>

      {/* ── Progress bars (city-batched runs) ─────────────────────────────── */}
      {status === 'running' && (batchPct !== null || leadPct !== null) && (
        <div className="px-4 pb-3 space-y-1.5">
          {/* Cities progress */}
          {batchPct !== null && batchProgress && (
            <div>
              <div className="flex justify-between text-xs opacity-70 mb-0.5">
                <span>Cities</span>
                <span>{batchProgress.citiesProcessed}/{batchProgress.totalCities}</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-1.5" role="progressbar" aria-valuenow={batchPct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${batchPct}%` }}
                />
              </div>
            </div>
          )}

          {/* Leads progress */}
          {leadPct !== null && (
            <div>
              <div className="flex justify-between text-xs opacity-70 mb-0.5">
                <span>Leads</span>
                <span>{leadCount}/{maxLeads}</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-1.5" role="progressbar" aria-valuenow={leadPct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="bg-green-500 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${leadPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Round-robin progress (per-selection state) ────────────────────── */}
      {status === 'running' && roundRobinProgress && roundRobinProgress.selections.length > 0 && (
        <div className="px-4 pb-3 border-t border-blue-200 pt-2">
          <div className="text-xs font-semibold text-blue-700 mb-1.5">
            Round {roundRobinProgress.currentRound} — Per-Selection Progress
          </div>
          <div className="space-y-1">
            {roundRobinProgress.selections.map((sel, idx) => {
              const pct = sel.totalCities > 0
                ? Math.round((sel.citiesYielded / sel.totalCities) * 100)
                : 0;
              return (
                <div key={idx} className="text-xs">
                  <div className="flex justify-between opacity-75 mb-0.5">
                    <span className="font-medium">
                      {sel.name}
                      {sel.exhausted && <span className="ml-1 text-blue-600">✓</span>}
                    </span>
                    <span>{sel.citiesYielded}/{sel.totalCities}</span>
                  </div>
                  <div className="w-full bg-blue-200 rounded-full h-1" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div
                      className={`h-1 rounded-full transition-all duration-500 ${sel.exhausted ? 'bg-blue-400' : 'bg-blue-600'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

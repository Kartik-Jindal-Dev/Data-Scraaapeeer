'use client';

import { useState, useCallback } from 'react';
import InputPanel from '../components/InputPanel';
import StatusBar from '../components/StatusBar';
import ResultsTable from '../components/ResultsTable';
import ExportButton from '../components/ExportButton';
import { useSSE } from '../hooks/useSSE';
import {
  Lead,
  JobStatus,
  ScrapeDepth,
  DiscardPayload,
  StatusPayload,
  ErrorPayload,
} from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function DashboardPage() {
  // ── Form state ──────────────────────────────────────────────────────────────
  const [keywords, setKeywords] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [depth, setDepth] = useState<ScrapeDepth>('homepage');

  // ── Job state ───────────────────────────────────────────────────────────────
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus>('idle');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [discardCount, setDiscardCount] = useState(0);

  // ── Error state ─────────────────────────────────────────────────────────────
  const [locationError, setLocationError] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const isRunning = jobStatus === 'running';

  // ── SSE handlers ────────────────────────────────────────────────────────────
  const handleLead = useCallback((lead: Lead) => {
    setLeads((prev) => [...prev, lead]);
  }, []);

  const handleDiscard = useCallback((payload: DiscardPayload) => {
    setDiscardCount(payload.total);
  }, []);

  const handleStatus = useCallback((payload: StatusPayload) => {
    setJobStatus(payload.status);
    setDiscardCount(payload.discardCount);
  }, []);

  const handleError = useCallback((payload: ErrorPayload) => {
    setErrorMessage(payload.message);
  }, []);

  // Wire SSE — only active when jobId is set
  useSSE(jobId, {
    onLead: handleLead,
    onDiscard: handleDiscard,
    onStatus: handleStatus,
    onError: handleError,
  });

  // ── Start job ────────────────────────────────────────────────────────────────
  async function handleStart() {
    setLocationError('');
    setErrorMessage('');
    setLeads([]);
    setDiscardCount(0);
    setJobId(null);

    try {
      const res = await fetch(`${API_BASE}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, locations, depth }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'invalid_location') {
          setLocationError(data.message ?? 'Invalid location. Please try again.');
        } else {
          setErrorMessage(data.message ?? 'Failed to start job.');
        }
        return;
      }

      setJobId(data.jobId);
      setJobStatus('running');
    } catch {
      setErrorMessage('Could not connect to the backend. Is it running?');
    }
  }

  // ── Stop job ─────────────────────────────────────────────────────────────────
  async function handleStop() {
    try {
      await fetch(`${API_BASE}/api/stop`, { method: 'POST' });
      // Status update arrives via SSE
    } catch {
      setErrorMessage('Failed to send stop signal.');
    }
  }

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
          Lead Scraper
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          In-house lead generation — public data only
        </p>
      </header>

      {/* Input panel */}
      <InputPanel
        keywords={keywords}
        locations={locations}
        depth={depth}
        locationError={locationError}
        isRunning={isRunning}
        onKeywordsChange={setKeywords}
        onLocationsChange={setLocations}
        onDepthChange={setDepth}
        onStart={handleStart}
        onStop={handleStop}
      />

      {/* Status bar */}
      <StatusBar
        status={jobStatus}
        leadCount={leads.length}
        discardCount={discardCount}
        errorMessage={errorMessage}
      />

      {/* Export button + discard note */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <ExportButton
          jobId={jobId ?? ''}
          leadCount={leads.length}
          status={jobStatus}
        />
        {discardCount > 0 && (
          <p className="text-sm text-gray-500" aria-live="polite">
            {discardCount} lead{discardCount !== 1 ? 's' : ''} discarded — no email or phone found
          </p>
        )}
      </div>

      {/* Results table */}
      <ResultsTable leads={leads} />

      {/* Footer */}
      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-200">
        Data is held in memory only. Export before stopping the server.
      </footer>
    </main>
  );
}

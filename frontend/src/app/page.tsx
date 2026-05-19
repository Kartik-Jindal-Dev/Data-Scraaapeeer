'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import InputPanel from '../components/InputPanel';
import StatusBar from '../components/StatusBar';
import ResultsTable from '../components/ResultsTable';
import ExportButton from '../components/ExportButton';
import { useSSE } from '../hooks/useSSE';
import {
  Lead,
  JobStatus,
  ScrapeDepth,
  ContactFilter,
  DiscardPayload,
  StatusPayload,
  ErrorPayload,
} from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export default function DashboardPage() {
  // ── Form state (Phase 13) ───────────────────────────────────────────────────
  const [profession, setProfession] = useState<string>('');
  const [country, setCountry] = useState<string>('');         // ISO code
  const [countryName, setCountryName] = useState<string>(''); // display name
  const [states, setStates] = useState<string[]>([]);
  const [maxLeads, setMaxLeads] = useState<number>(100);
  const [depth, setDepth] = useState<ScrapeDepth>('homepage');
  const [contactFilter, setContactFilter] = useState<ContactFilter>('any');
  const [useSerper, setUseSerper] = useState<boolean>(true);

  function handleCountryChange(isoCode: string, name: string) {
    setCountry(isoCode);
    setCountryName(name);
    setStates([]); // reset states when country changes
  }

  // ── Job state ───────────────────────────────────────────────────────────────
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus>('idle');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [discardCount, setDiscardCount] = useState(0);
  const [activeKeyword, setActiveKeyword] = useState('');
  const [activeLocation, setActiveLocation] = useState('');
  const [batchProgress, setBatchProgress] = useState<StatusPayload['batchProgress']>(undefined);
  const [roundRobinProgress, setRoundRobinProgress] = useState<StatusPayload['roundRobinProgress']>(undefined);

  // ── Error state ─────────────────────────────────────────────────────────────
  const [locationError, setLocationError] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const isRunning = jobStatus === 'running';

  // ── SSE handlers ────────────────────────────────────────────────────────────
  const handleLead = useCallback((lead: Lead) => {
    setLeads((prev) => {
      // For large runs, avoid spreading the full array on every event.
      // Push directly — React batches these updates efficiently.
      const next = prev.concat(lead);
      return next;
    });
  }, []);

  const handleDiscard = useCallback((payload: DiscardPayload) => {
    setDiscardCount(payload.total);
  }, []);

  const handleStatus = useCallback((payload: StatusPayload) => {
    setJobStatus(payload.status);
    setDiscardCount(payload.discardCount);
    if (payload.activeKeyword !== undefined) setActiveKeyword(payload.activeKeyword);
    if (payload.activeLocation !== undefined) setActiveLocation(payload.activeLocation);
    if (payload.batchProgress !== undefined) setBatchProgress(payload.batchProgress);
    if (payload.roundRobinProgress !== undefined) setRoundRobinProgress(payload.roundRobinProgress);
  }, []);

  const handleError = useCallback((payload: ErrorPayload) => {
    setErrorMessage(payload.message);
  }, []);

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
    setActiveKeyword('');
    setActiveLocation('');
    setBatchProgress(undefined);
    setRoundRobinProgress(undefined);

    // profession field is the keyword directly (free text)
    const keyword = profession.trim();
    if (!keyword) {
      setErrorMessage('Please enter a keyword or profession.');
      return;
    }
    if (!country) {
      setLocationError('Please select a country.');
      return;
    }
    if (states.length === 0) {
      setLocationError('Please add at least one state or region.');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword,
          country: country.trim(),
          states,
          maxLeads,
          depth,
          contactFilter,
          useSerper,
        }),
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
    } catch {
      setErrorMessage('Failed to send stop signal.');
    }
  }

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
            Lead Scraper
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            In-house lead generation — public data only
          </p>
        </div>
        <Link
          href="/jobs"
          className="text-sm text-indigo-600 hover:text-indigo-800 underline mt-1"
        >
          Job History →
        </Link>
      </header>

      {/* Input panel */}
      <InputPanel
        profession={profession}
        country={country}
        countryName={countryName}
        states={states}
        maxLeads={maxLeads}
        depth={depth}
        contactFilter={contactFilter}
        useSerper={useSerper}
        locationError={locationError}
        isRunning={isRunning}
        onProfessionChange={setProfession}
        onCountryChange={handleCountryChange}
        onStatesChange={setStates}
        onMaxLeadsChange={setMaxLeads}
        onDepthChange={setDepth}
        onContactFilterChange={setContactFilter}
        onUseSerperChange={setUseSerper}
        onStart={handleStart}
        onStop={handleStop}
      />

      {/* Status bar */}
      <StatusBar
        status={jobStatus}
        leadCount={leads.length}
        discardCount={discardCount}
        errorMessage={errorMessage}
        activeKeyword={activeKeyword}
        activeLocation={activeLocation}
        batchProgress={batchProgress}
        roundRobinProgress={roundRobinProgress}
        maxLeads={maxLeads}
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

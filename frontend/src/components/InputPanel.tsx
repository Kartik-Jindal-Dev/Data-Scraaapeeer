'use client';

import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { ContactFilter, ScrapeDepth, PROFESSION_LABELS } from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface CountryOption { name: string; isoCode: string; }
interface StateOption   { name: string; isoCode: string; }

// ─── Props ────────────────────────────────────────────────────────────────────

interface InputPanelProps {
  profession: string;
  country: string;
  countryName: string;
  states: string[];
  maxLeads: number;
  depth: ScrapeDepth;
  contactFilter: ContactFilter;
  useSerper: boolean;
  locationError: string;
  isRunning: boolean;
  onProfessionChange: (v: string) => void;
  onCountryChange: (isoCode: string, name: string) => void;
  onStatesChange: (states: string[]) => void;
  onMaxLeadsChange: (n: number) => void;
  onDepthChange: (v: ScrapeDepth) => void;
  onContactFilterChange: (v: ContactFilter) => void;
  onUseSerperChange: (v: boolean) => void;
  onStart: () => void;
  onStop: () => void;
}

export default function InputPanel({
  profession,
  country,
  countryName,
  states,
  maxLeads,
  depth,
  contactFilter,
  useSerper,
  locationError,
  isRunning,
  onProfessionChange,
  onCountryChange,
  onStatesChange,
  onMaxLeadsChange,
  onDepthChange,
  onContactFilterChange,
  onUseSerperChange,
  onStart,
  onStop,
}: InputPanelProps) {
  // ── Country data ──────────────────────────────────────────────────────────
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [countriesLoading, setCountriesLoading] = useState(false);

  // ── State data ────────────────────────────────────────────────────────────
  const [availableStates, setAvailableStates] = useState<StateOption[]>([]);
  const [statesLoading, setStatesLoading] = useState(false);

  // ── State dropdown open/close ─────────────────────────────────────────────
  const [stateDropdownOpen, setStateDropdownOpen] = useState(false);
  const [stateSearch, setStateSearch] = useState('');
  const stateDropdownRef = useRef<HTMLDivElement>(null);

  // ── Load countries on mount ───────────────────────────────────────────────
  useEffect(() => {
    setCountriesLoading(true);
    fetch(`${API_BASE}/api/locations/countries`)
      .then((r) => r.json())
      .then((data: CountryOption[]) => setCountries(data))
      .catch(() => {/* silently fail — user can still type */})
      .finally(() => setCountriesLoading(false));
  }, []);

  // ── Load states when country changes ─────────────────────────────────────
  useEffect(() => {
    if (!country) {
      setAvailableStates([]);
      onStatesChange([]);
      return;
    }
    setStatesLoading(true);
    setAvailableStates([]);
    onStatesChange([]);
    fetch(`${API_BASE}/api/locations/states?country=${encodeURIComponent(country)}`)
      .then((r) => r.json())
      .then((data: StateOption[]) => setAvailableStates(data))
      .catch(() => {})
      .finally(() => setStatesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  // ── Close state dropdown on outside click ─────────────────────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (stateDropdownRef.current && !stateDropdownRef.current.contains(e.target as Node)) {
        setStateDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ── State toggle ──────────────────────────────────────────────────────────
  function toggleState(name: string) {
    if (states.includes(name)) {
      onStatesChange(states.filter((s) => s !== name));
    } else {
      onStatesChange([...states, name]);
    }
  }

  function selectAllStates() {
    onStatesChange(availableStates.map((s) => s.name));
  }

  function clearAllStates() {
    onStatesChange([]);
  }

  // ── Filtered states for search ────────────────────────────────────────────
  const filteredStates = availableStates.filter((s) =>
    s.name.toLowerCase().includes(stateSearch.toLowerCase())
  );

  const canStart = profession.trim().length > 0 && country.length > 0 && states.length > 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">

      {/* ── Keyword / Profession ─────────────────────────────────────────── */}
      <div>
        <label htmlFor="profession" className="block text-sm font-medium text-gray-700 mb-1">
          Keyword / Profession
        </label>
        <datalist id="profession-suggestions">
          {PROFESSION_LABELS.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        <input
          id="profession"
          type="text"
          list="profession-suggestions"
          value={profession}
          onChange={(e) => onProfessionChange(e.target.value)}
          placeholder="e.g. plumber, dentist, real estate agent"
          disabled={isRunning}
          autoComplete="off"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          aria-label="Keyword or profession"
        />
        <p className="mt-1 text-xs text-gray-400">
          Type any keyword or pick a suggestion. 1 keyword per run — cities expand automatically.
        </p>
      </div>

      {/* ── Country dropdown ─────────────────────────────────────────────── */}
      <div>
        <label htmlFor="country-select" className="block text-sm font-medium text-gray-700 mb-1">
          Country
        </label>
        <select
          id="country-select"
          value={country}
          onChange={(e) => {
            const selected = countries.find((c) => c.isoCode === e.target.value);
            onCountryChange(e.target.value, selected?.name ?? '');
          }}
          disabled={isRunning || countriesLoading}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          aria-label="Select country"
        >
          <option value="">
            {countriesLoading ? 'Loading countries…' : '— Select a country —'}
          </option>
          {countries.map((c) => (
            <option key={c.isoCode} value={c.isoCode}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* ── States multi-select dropdown ─────────────────────────────────── */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          States / Regions
          <span className="ml-1 text-xs text-gray-400 font-normal">
            ({states.length} selected{availableStates.length > 0 ? ` of ${availableStates.length}` : ''})
          </span>
        </label>

        {/* Selected state chips */}
        {states.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2" aria-label="Selected states">
            {states.map((s) => (
              <span
                key={s}
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                  locationError ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
                }`}
              >
                {s}
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() => toggleState(s)}
                    className="ml-0.5 hover:opacity-70 focus:outline-none"
                    aria-label={`Remove ${s}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Dropdown trigger */}
        <div className="relative" ref={stateDropdownRef}>
          <button
            type="button"
            onClick={() => !isRunning && country && setStateDropdownOpen((o) => !o)}
            disabled={isRunning || !country || statesLoading}
            className="w-full flex items-center justify-between border border-gray-300 rounded px-3 py-2 text-sm text-left bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            aria-haspopup="listbox"
            aria-expanded={stateDropdownOpen}
          >
            <span className="text-gray-500">
              {statesLoading
                ? 'Loading states…'
                : !country
                ? 'Select a country first'
                : states.length === 0
                ? 'Select states / regions…'
                : `${states.length} state${states.length !== 1 ? 's' : ''} selected`}
            </span>
            <span className="text-gray-400 ml-2">{stateDropdownOpen ? '▲' : '▼'}</span>
          </button>

          {/* Dropdown panel */}
          {stateDropdownOpen && availableStates.length > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg">
              {/* Search + bulk actions */}
              <div className="p-2 border-b border-gray-100 space-y-1.5">
                <input
                  type="text"
                  value={stateSearch}
                  onChange={(e) => setStateSearch(e.target.value)}
                  placeholder="Search states…"
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
                  aria-label="Search states"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAllStates}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Select all
                  </button>
                  <span className="text-gray-300">|</span>
                  <button
                    type="button"
                    onClick={clearAllStates}
                    className="text-xs text-gray-500 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {/* State list */}
              <ul
                className="max-h-52 overflow-y-auto py-1"
                role="listbox"
                aria-multiselectable="true"
                aria-label="States"
              >
                {filteredStates.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-gray-400">No states match</li>
                ) : (
                  filteredStates.map((s) => {
                    const checked = states.includes(s.name);
                    return (
                      <li
                        key={s.isoCode}
                        role="option"
                        aria-selected={checked}
                        onClick={() => toggleState(s.name)}
                        className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 ${
                          checked ? 'bg-blue-50 text-blue-800' : 'text-gray-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleState(s.name)}
                          className="accent-blue-600 pointer-events-none"
                          aria-hidden="true"
                          tabIndex={-1}
                        />
                        {s.name}
                      </li>
                    );
                  })
                )}
              </ul>

              {/* Close button */}
              <div className="p-2 border-t border-gray-100 text-right">
                <button
                  type="button"
                  onClick={() => setStateDropdownOpen(false)}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {locationError && (
          <p id="location-error" role="alert" className="mt-1 text-xs text-red-600">
            {locationError}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-400">
          Cities are fetched automatically per state. All cities are tried before giving up.
        </p>
      </div>

      {/* ── Max Leads ────────────────────────────────────────────────────── */}
      <div>
        <label htmlFor="maxLeads" className="block text-sm font-medium text-gray-700 mb-1">
          Max Leads
        </label>
        <input
          id="maxLeads"
          type="number"
          min={1}
          max={10000}
          value={maxLeads}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) onMaxLeadsChange(v);
          }}
          disabled={isRunning}
          className="w-40 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          aria-label="Maximum leads to collect"
        />
        <p className="mt-1 text-xs text-gray-400">
          Scraping stops automatically when this target is reached.
        </p>
      </div>

      {/* ── Depth toggle ─────────────────────────────────────────────────── */}
      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">Depth</span>
        <div className="flex gap-4" role="radiogroup" aria-label="Scraping depth">
          {(['homepage', 'indepth'] as ScrapeDepth[]).map((d) => (
            <label key={d} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="depth"
                value={d}
                checked={depth === d}
                onChange={() => onDepthChange(d)}
                disabled={isRunning}
                className="accent-blue-600"
              />
              <span className="text-sm text-gray-700">
                {d === 'homepage' ? 'Homepage only' : 'In-depth'}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* ── Contact filter ────────────────────────────────────────────────── */}
      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">Keep leads with</span>
        <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Contact filter">
          {(
            [
              { value: 'any',        label: 'Email or Phone' },
              { value: 'email_only', label: 'Email only' },
              { value: 'phone_only', label: 'Phone only' },
              { value: 'both',       label: 'Both' },
            ] as { value: ContactFilter; label: string }[]
          ).map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contactFilter"
                value={value}
                checked={contactFilter === value}
                onChange={() => onContactFilterChange(value)}
                disabled={isRunning}
                className="accent-blue-600"
                aria-label={label}
              />
              <span className="text-sm text-gray-700">{label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* ── Discovery source toggle ───────────────────────────────────── */}
      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">Discovery source</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={useSerper}
            onClick={() => !isRunning && onUseSerperChange(!useSerper)}
            disabled={isRunning}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed ${
              useSerper ? 'bg-blue-600' : 'bg-gray-300'
            }`}
            aria-label="Toggle Serper API"
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                useSerper ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <div>
            <span className="text-sm font-medium text-gray-700">
              {useSerper ? 'Serper API' : 'Google Maps'}
            </span>
            <p className="text-xs text-gray-400">
              {useSerper
                ? 'Fast (~2s/city) — uses paid Serper API key'
                : 'Free but slow (~20s/city) — Playwright scrapes Google Maps'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Action buttons ────────────────────────────────────────────────── */}
      <div className="flex gap-3 pt-1">
        <button
          onClick={onStart}
          disabled={isRunning || !canStart}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          aria-label="Start scraping job"
        >
          <span aria-hidden="true">▶</span> Start
        </button>
        <button
          onClick={onStop}
          disabled={!isRunning}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 text-white text-sm font-medium rounded hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1"
          aria-label="Stop scraping job"
        >
          <span aria-hidden="true">■</span> Stop
        </button>
      </div>
    </div>
  );
}

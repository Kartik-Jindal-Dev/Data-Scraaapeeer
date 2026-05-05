'use client';

import { useState, KeyboardEvent } from 'react';
import { ScrapeDepth } from '../types';

interface InputPanelProps {
  keywords: string[];
  locations: string[];
  depth: ScrapeDepth;
  locationError: string;
  isRunning: boolean;
  onKeywordsChange: (v: string[]) => void;
  onLocationsChange: (v: string[]) => void;
  onDepthChange: (v: ScrapeDepth) => void;
  onStart: () => void;
  onStop: () => void;
}

export default function InputPanel({
  keywords,
  locations,
  depth,
  locationError,
  isRunning,
  onKeywordsChange,
  onLocationsChange,
  onDepthChange,
  onStart,
  onStop,
}: InputPanelProps) {
  const [keywordInput, setKeywordInput] = useState('');
  const [locationInput, setLocationInput] = useState('');

  function addKeyword(value: string) {
    const trimmed = value.trim();
    if (!trimmed || keywords.includes(trimmed) || keywords.length >= 5) return;
    onKeywordsChange([...keywords, trimmed]);
    setKeywordInput('');
  }

  function removeKeyword(kw: string) {
    onKeywordsChange(keywords.filter((k) => k !== kw));
  }

  function handleKeywordKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKeyword(keywordInput);
    }
  }

  function addLocation(value: string) {
    const trimmed = value.trim();
    if (!trimmed || locations.includes(trimmed) || locations.length >= 5) return;
    onLocationsChange([...locations, trimmed]);
    setLocationInput('');
  }

  function removeLocation(loc: string) {
    onLocationsChange(locations.filter((l) => l !== loc));
  }

  function handleLocationKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addLocation(locationInput);
    }
  }

  const canStart = keywords.length > 0 && locations.length > 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
      {/* Keywords */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Keywords
          <span className="ml-1 text-xs text-gray-400 font-normal">
            ({keywords.length}/5)
          </span>
        </label>

        {/* Keyword chips */}
        {keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2" aria-label="Selected keywords">
            {keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded-full"
              >
                {kw}
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    className="ml-0.5 text-blue-500 hover:text-blue-700 focus:outline-none"
                    aria-label={`Remove keyword ${kw}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <input
          id="keyword"
          type="text"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          onKeyDown={handleKeywordKeyDown}
          onBlur={() => addKeyword(keywordInput)}
          placeholder={keywords.length === 0 ? 'e.g. dental clinic' : 'Add another keyword…'}
          disabled={isRunning || keywords.length >= 5}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          aria-label="Add keyword"
        />
        <p className="mt-1 text-xs text-gray-400">Press Enter or comma to add. Max 5.</p>
      </div>

      {/* Locations */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Locations
          <span className="ml-1 text-xs text-gray-400 font-normal">
            ({locations.length}/5)
          </span>
        </label>

        {/* Location chips */}
        {locations.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2" aria-label="Selected locations">
            {locations.map((loc) => (
              <span
                key={loc}
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full ${
                  locationError
                    ? 'bg-red-100 text-red-800'
                    : 'bg-green-100 text-green-800'
                }`}
              >
                {loc}
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() => removeLocation(loc)}
                    className="ml-0.5 hover:opacity-70 focus:outline-none"
                    aria-label={`Remove location ${loc}`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        <input
          id="location"
          type="text"
          value={locationInput}
          onChange={(e) => setLocationInput(e.target.value)}
          onKeyDown={handleLocationKeyDown}
          onBlur={() => addLocation(locationInput)}
          placeholder={locations.length === 0 ? 'e.g. London, UK' : 'Add another location…'}
          disabled={isRunning || locations.length >= 5}
          aria-describedby={locationError ? 'location-error' : undefined}
          aria-invalid={!!locationError}
          className={`w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed ${
            locationError ? 'border-red-400' : 'border-gray-300'
          }`}
          aria-label="Add location"
        />
        <p className="mt-1 text-xs text-gray-400">Press Enter or comma to add. Max 5.</p>
        {locationError && (
          <p id="location-error" role="alert" className="mt-1 text-xs text-red-600">
            {locationError}
          </p>
        )}
      </div>

      {/* Depth toggle */}
      <div>
        <span className="block text-sm font-medium text-gray-700 mb-2">Depth</span>
        <div className="flex gap-4" role="radiogroup" aria-label="Scraping depth">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="depth"
              value="homepage"
              checked={depth === 'homepage'}
              onChange={() => onDepthChange('homepage')}
              disabled={isRunning}
              className="accent-blue-600"
              aria-label="Homepage only"
            />
            <span className="text-sm text-gray-700">Homepage only</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="depth"
              value="indepth"
              checked={depth === 'indepth'}
              onChange={() => onDepthChange('indepth')}
              disabled={isRunning}
              className="accent-blue-600"
              aria-label="In-depth"
            />
            <span className="text-sm text-gray-700">In-depth</span>
          </label>
        </div>
      </div>

      {/* Action buttons */}
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

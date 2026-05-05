'use client';

import { JobStatus } from '../types';

interface StatusBarProps {
  status: JobStatus;
  leadCount: number;
  discardCount: number;
  errorMessage: string;
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

export default function StatusBar({
  status,
  leadCount,
  discardCount,
  errorMessage,
}: StatusBarProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-4 px-4 py-3 rounded-lg text-sm ${STATUS_COLORS[status]}`}
      role="status"
      aria-live="polite"
      aria-label={`Job status: ${STATUS_LABELS[status]}`}
    >
      {/* Status badge */}
      <span className="font-semibold">{STATUS_LABELS[status]}</span>

      {/* Lead count */}
      <span>
        <span className="font-medium">{leadCount}</span>{' '}
        {leadCount === 1 ? 'lead' : 'leads'} found
      </span>

      {/* Discard count */}
      {discardCount > 0 && (
        <span className="text-gray-500">
          {discardCount} discarded (no contact info)
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
  );
}

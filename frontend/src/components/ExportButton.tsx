'use client';

import { JobStatus } from '../types';

interface ExportButtonProps {
  jobId: string;
  leadCount: number;
  status: JobStatus;
}

export default function ExportButton({ jobId, leadCount, status }: ExportButtonProps) {
  const canExport =
    leadCount > 0 && (status === 'completed' || status === 'stopped');

  function handleExport() {
    if (!canExport || !jobId) return;
    // Trigger browser file download — no fetch needed
    window.location.href = `/api/export?jobId=${encodeURIComponent(jobId)}`;
  }

  return (
    <button
      onClick={handleExport}
      disabled={!canExport}
      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-1"
      aria-label={
        canExport
          ? `Export ${leadCount} leads to Excel`
          : 'Export unavailable — complete or stop a job first'
      }
      title={
        canExport
          ? `Download ${leadCount} leads as .xlsx`
          : 'Complete or stop a job to enable export'
      }
    >
      <span aria-hidden="true">↓</span> Export to Excel
      {leadCount > 0 && (
        <span className="ml-1 text-green-200 text-xs">({leadCount})</span>
      )}
    </button>
  );
}

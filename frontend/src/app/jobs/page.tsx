'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { JobStatus } from '../../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface JobRecord {
  id: string;
  keyword: string;
  location: string;
  status: string;
  lead_count: number;
  discard_count: number;
  created_at: number;
  completed_at: number | null;
}

interface StatsSnapshot {
  totalJobs: number;
  totalLeads: number;
  totalDiscards: number;
}

interface PaginatedResponse {
  jobs: JobRecord[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

export default function JobHistoryPage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobLeads, setJobLeads] = useState<any[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 50;

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (statusFilter) params.set('status', statusFilter);
      const [jobsRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/api/jobs?${params}`),
        fetch(`${API_BASE}/api/jobs/stats`),
      ]);

      if (!jobsRes.ok) throw new Error('Failed to fetch jobs');

      const data: PaginatedResponse = await jobsRes.json();
      setJobs(data.jobs);
      setHasMore(data.pagination.hasMore);
      setTotal(data.pagination.total);

      if (statsRes.ok) {
        const statsData: StatsSnapshot = await statsRes.json();
        setStats(statsData);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  async function fetchJobLeads(jobId: string) {
    if (selectedJobId === jobId) {
      setSelectedJobId(null);
      setJobLeads([]);
      return;
    }
    setSelectedJobId(jobId);
    setLeadsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/jobs/${jobId}/leads`);
      if (!res.ok) throw new Error('Failed to fetch leads');
      const data = await res.json();
      setJobLeads(data.leads ?? []);
    } catch (err) {
      setError((err as Error).message);
      setJobLeads([]);
    } finally {
      setLeadsLoading(false);
    }
  }

  function getStatusBadgeClass(status: string): string {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800';
      case 'running':   return 'bg-blue-100 text-blue-800';
      case 'stopped':   return 'bg-yellow-100 text-yellow-800';
      case 'error':     return 'bg-red-100 text-red-800';
      default:          return 'bg-gray-100 text-gray-800';
    }
  }

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Job History</h1>
          <p className="text-sm text-gray-500 mt-0.5">Browse past scrapes and export leads</p>
        </div>
        <Link href="/" className="text-sm text-indigo-600 hover:text-indigo-800 underline">
          ← Back to Dashboard
        </Link>
      </header>

      {/* Persistent stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Jobs</p>
            <p className="text-2xl font-bold text-gray-900">{stats.totalJobs}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Total Leads (all time)</p>
            <p className="text-2xl font-bold text-gray-900">{total}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Status</p>
            <p className="text-sm text-gray-600 mt-1">Data persists across restarts</p>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">Filter by status:</label>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm"
        >
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="stopped">Stopped</option>
          <option value="error">Error</option>
          <option value="running">Running</option>
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">{error}</div>
      )}

      {/* Jobs table */}
      {loading ? (
        <p className="text-gray-500">Loading jobs...</p>
      ) : jobs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-gray-500">No jobs found. Run a scrape first.</p>
          <Link href="/" className="text-indigo-600 hover:text-indigo-800 underline text-sm mt-2 inline-block">
            Go to Dashboard
          </Link>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Keyword</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Location</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Leads</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">Discards</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{job.keyword}</td>
                    <td className="px-4 py-3 text-gray-600">{job.location}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeClass(job.status)}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-900 font-medium">{job.lead_count}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{job.discard_count}</td>
                    <td className="px-4 py-3 space-x-2">
                      <button
                        onClick={() => fetchJobLeads(job.id)}
                        className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                      >
                        {selectedJobId === job.id ? 'Hide' : 'View'} Leads
                      </button>
                      <a
                        href={`${API_BASE}/api/export?job_id=${encodeURIComponent(job.id)}`}
                        className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                        download
                      >
                        Export
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>{total} job{total !== 1 ? 's' : ''} total</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 hover:bg-gray-50"
              >
                Previous
              </button>
              <span className="px-3 py-1">Page {page + 1}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasMore}
                className="px-3 py-1 border border-gray-300 rounded disabled:opacity-50 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>

          {/* Lead detail panel */}
          {selectedJobId && (
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
                <h3 className="font-medium text-gray-900">Leads for job {selectedJobId.slice(0, 8)}...</h3>
                <a
                  href={`${API_BASE}/api/export?job_id=${encodeURIComponent(selectedJobId)}`}
                  className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                  download
                >
                  Export All
                </a>
              </div>
              {leadsLoading ? (
                <p className="p-4 text-gray-500 text-sm">Loading leads...</p>
              ) : jobLeads.length === 0 ? (
                <p className="p-4 text-gray-500 text-sm">No leads for this job.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Business</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Email</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Phone</th>
                        <th className="text-left px-4 py-2 font-medium text-gray-600">Website</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {jobLeads.slice(0, 50).map((lead: any, i: number) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-medium text-gray-900">{lead.businessName}</td>
                          <td className="px-4 py-2 text-blue-600">
                            {lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : '-'}
                          </td>
                          <td className="px-4 py-2 text-gray-600">{lead.phone || '-'}</td>
                          <td className="px-4 py-2 text-blue-600 max-w-[200px] truncate">
                            {lead.website ? <a href={lead.website} target="_blank" rel="noopener noreferrer">{lead.website}</a> : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {jobLeads.length > 50 && (
                    <p className="px-4 py-2 text-xs text-gray-500">
                      Showing 50 of {jobLeads.length} leads. Use Export to get all.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-200">
        Data persists in SQLite database across server restarts.
      </footer>
    </main>
  );
}
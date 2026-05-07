'use client';

import { Lead } from '../types';

interface ResultsTableProps {
  leads: Lead[];
}

// Show at most this many rows in the live table to keep the browser responsive.
// All leads are still stored in memory and exported to Excel in full.
const TABLE_DISPLAY_LIMIT = 500;

export default function ResultsTable({ leads }: ResultsTableProps) {
  if (leads.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm" aria-live="polite">
        No leads yet. Start a job to see results here.
      </div>
    );
  }

  // Only render the most recent TABLE_DISPLAY_LIMIT leads in the DOM.
  // Older leads are still in memory and will appear in the export.
  const displayLeads = leads.length > TABLE_DISPLAY_LIMIT
    ? leads.slice(-TABLE_DISPLAY_LIMIT)
    : leads;
  const hiddenCount = leads.length - displayLeads.length;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      {hiddenCount > 0 && (
        <div className="px-4 py-2 bg-blue-50 text-blue-700 text-xs border-b border-blue-100">
          Showing latest {TABLE_DISPLAY_LIMIT} of {leads.length} leads — all {leads.length} will be in the export.
        </div>
      )}
      <table className="min-w-full text-sm" aria-label="Leads results table">
        <thead className="bg-gray-800 text-white">
          <tr>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Business Name
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Email
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Phone
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Website
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Address
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold whitespace-nowrap">
              Contact Form
            </th>
          </tr>
        </thead>
        <tbody>
          {displayLeads.map((lead, idx) => {
            const hasBoth = !!lead.email && !!lead.phone;
            return (
              <tr
                key={idx}
                className={`border-t border-gray-100 ${
                  hasBoth ? 'bg-green-50' : 'bg-white'
                } hover:bg-gray-50 transition-colors`}
                aria-label={`Lead: ${lead.businessName}`}
              >
                <td className="px-4 py-2 font-medium text-gray-900 whitespace-nowrap max-w-[200px] truncate">
                  {lead.businessName}
                </td>
                <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
                  {lead.email ? (
                    <a
                      href={`mailto:${lead.email}`}
                      className="text-blue-600 hover:underline"
                      aria-label={`Email ${lead.businessName}: ${lead.email}`}
                    >
                      {lead.email}
                    </a>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
                  {lead.phone ? (
                    <a
                      href={`tel:${lead.phone}`}
                      className="text-blue-600 hover:underline"
                      aria-label={`Call ${lead.businessName}: ${lead.phone}`}
                    >
                      {lead.phone}
                    </a>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 whitespace-nowrap max-w-[180px] truncate">
                  {lead.website ? (
                    <a
                      href={lead.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                      aria-label={`Visit website of ${lead.businessName}`}
                    >
                      {lead.website.replace(/^https?:\/\//, '')}
                    </a>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-gray-600 max-w-[220px] truncate">
                  {lead.address || <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-2 text-center text-gray-700 whitespace-nowrap">
                  {lead.hasContactForm ? (
                    <span title="Contact form detected" aria-label="Contact form detected">✓</span>
                  ) : (
                    <span className="text-gray-400" aria-label="No contact form detected"></span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

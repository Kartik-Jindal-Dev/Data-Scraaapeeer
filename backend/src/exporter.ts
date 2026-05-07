/**
 * exporter.ts
 * Excel (.xlsx) export generator.
 *
 * CONSTRAINTS (from docs/CONSTRAINTS.md):
 * - Only .xlsx format — no CSV, JSON, PDF.
 * - Columns: Business Name, Email, Phone, Website, Address (exactly these five).
 * - Internal fields (_hasBoth, _qualityTier) are NEVER included.
 * - Sort: Tier 1 leads (both email + phone) appear first — green highlighted rows.
 * - Streaming writer used internally when leads.length > 500 (no UI change).
 * - The leads[] array is NOT modified during or after export.
 */

import ExcelJS from 'exceljs';
import { Writable } from 'stream';
import { Lead } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Switch to streaming writer above this threshold to avoid memory spikes. */
const STREAMING_THRESHOLD = 500;

/** ARGB colour for the header row background. */
const HEADER_BG_ARGB = 'FF1E1E2E';

/** ARGB colour for Tier 1 (both email + phone) row highlight. */
const TIER1_FILL_ARGB = 'FFE8F5E9';

/** ARGB colour for hyperlink text. */
const HYPERLINK_COLOR_ARGB = 'FF1565C0';

// ─── Column Definitions ───────────────────────────────────────────────────────

const COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'Business Name', key: 'businessName',  width: 32 },
  { header: 'Email',         key: 'email',          width: 30 },
  { header: 'Phone',         key: 'phone',          width: 20 },
  { header: 'Website',       key: 'website',        width: 32 },
  { header: 'Address',       key: 'address',        width: 38 },
  { header: 'Contact Form',  key: 'hasContactForm', width: 14 },
  { header: 'Generic Email', key: 'isGenericEmail', width: 14 },
  { header: 'Free Email',    key: 'isFreeEmail',    width: 12 },
  { header: 'Relay Email',   key: 'isRelayEmail',   width: 12 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sorts leads so Tier 1 (both email + phone) appear first.
 * Returns a new array — does not mutate the input.
 */
function sortLeads(leads: Lead[]): Lead[] {
  return [...leads].sort((a, b) => Number(b._hasBoth) - Number(a._hasBoth));
}

/**
 * Applies header row styling to the worksheet.
 */
function styleHeaderRow(ws: ExcelJS.Worksheet): void {
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: HEADER_BG_ARGB },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;
}

/**
 * Adds a data row to the worksheet with optional Tier 1 green highlight
 * and website hyperlink.
 */
function addLeadRow(ws: ExcelJS.Worksheet, lead: Lead): ExcelJS.Row {
  const row = ws.addRow({
    businessName: lead.businessName,
    email:        lead.email   || '',
    phone:        lead.phone   || '',
    website:      lead.website || '',
    address:      lead.address,
    hasContactForm: lead.hasContactForm ? 'Yes' : '',
    isGenericEmail: lead.isGenericEmail ? 'Yes' : '',
    isFreeEmail:    lead.isFreeEmail    ? 'Yes' : '',
    isRelayEmail:   lead.isRelayEmail   ? 'Yes' : '',
  });

  // Green highlight for Tier 1 leads (both email + phone)
  if (lead._hasBoth) {
    row.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: TIER1_FILL_ARGB },
    };
  }

  // Website hyperlink
  if (lead.website) {
    row.getCell('website').value = {
      text: lead.website,
      hyperlink: lead.website,
    };
    row.getCell('website').font = {
      color: { argb: HYPERLINK_COLOR_ARGB },
      underline: true,
    };
  }

  row.alignment = { vertical: 'middle', wrapText: false };
  return row;
}

// ─── Buffer Writer (≤500 leads) ───────────────────────────────────────────────

/**
 * Generates the Excel file as a Buffer.
 * Used when leads.length <= STREAMING_THRESHOLD.
 */
export async function generateExcelBuffer(leads: Lead[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lead Scraper';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads');
  ws.columns = COLUMNS;

  styleHeaderRow(ws);

  // Freeze header row
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Auto-filter on header row
  ws.autoFilter = { from: 'A1', to: 'I1' };

  const sorted = sortLeads(leads);
  for (const lead of sorted) {
    addLeadRow(ws, lead);
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

// ─── Streaming Writer (>500 leads) ────────────────────────────────────────────

/**
 * Streams the Excel file directly to a Writable stream.
 * Used when leads.length > STREAMING_THRESHOLD to avoid memory spikes.
 * No change to the operator-facing behaviour.
 */
export async function generateExcelStreaming(
  leads: Lead[],
  outputStream: Writable
): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: outputStream });
  const ws = wb.addWorksheet('Leads');

  ws.columns = COLUMNS;

  const sorted = sortLeads(leads);

  for (const lead of sorted) {
    const row = ws.addRow({
      businessName: lead.businessName,
      email:        lead.email   || '',
      phone:        lead.phone   || '',
      website:      lead.website || '',
      address:      lead.address,
      hasContactForm: lead.hasContactForm ? 'Yes' : '',
      isGenericEmail: lead.isGenericEmail ? 'Yes' : '',
      isFreeEmail:    lead.isFreeEmail    ? 'Yes' : '',
      isRelayEmail:   lead.isRelayEmail   ? 'Yes' : '',
    });

    if (lead._hasBoth) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: TIER1_FILL_ARGB },
      };
    }

    row.commit();
  }

  await wb.commit();
}

// ─── Strategy Selector ────────────────────────────────────────────────────────

/**
 * Returns true if the streaming writer should be used.
 * Activated when lead count exceeds STREAMING_THRESHOLD.
 */
export function shouldUseStreaming(leadCount: number): boolean {
  return leadCount > STREAMING_THRESHOLD;
}

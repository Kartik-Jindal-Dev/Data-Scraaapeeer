/**
 * exporter.test.ts
 * Unit tests for the Excel exporter.
 *
 * Covers:
 * - generateExcelBuffer produces a valid Buffer
 * - Tier 1 leads (both email + phone) appear before Tier 2/3 in sorted output
 * - shouldUseStreaming threshold logic
 * - Empty leads array produces a valid (header-only) workbook
 */

import ExcelJS from 'exceljs';
import { generateExcelBuffer, shouldUseStreaming } from './exporter';
import { Lead, QualityTier } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    businessName: 'Acme Corp',
    email: 'info@acme.com',
    phone: '+12025551234',
    website: 'https://acme.com',
    address: '123 Main St',
    _hasBoth: true,
    _qualityTier: 'Tier1' as QualityTier,
    ...overrides,
  };
}

async function parseBuffer(buffer: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's load() type definition conflicts with Node's Buffer in some versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (wb.xlsx.load as any)(buffer);
  return wb.getWorksheet('Leads')!;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateExcelBuffer()', () => {
  it('returns a Buffer', async () => {
    const buf = await generateExcelBuffer([makeLead()]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('produces a worksheet named "Leads"', async () => {
    const buf = await generateExcelBuffer([makeLead()]);
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wb.xlsx.load as any)(buf);
    expect(wb.getWorksheet('Leads')).toBeDefined();
  });

  it('includes exactly 6 columns with correct headers', async () => {
    const buf = await generateExcelBuffer([makeLead()]);
    const ws = await parseBuffer(buf);
    const headers = ws.getRow(1).values as string[];
    // ExcelJS row values are 1-indexed (index 0 is undefined)
    expect(headers[1]).toBe('Business Name');
    expect(headers[2]).toBe('Email');
    expect(headers[3]).toBe('Phone');
    expect(headers[4]).toBe('Website');
    expect(headers[5]).toBe('Address');
    expect(headers[6]).toBe('Contact Form');
  });

  it('does NOT include _hasBoth or _qualityTier columns', async () => {
    const buf = await generateExcelBuffer([makeLead()]);
    const ws = await parseBuffer(buf);
    const headers = (ws.getRow(1).values as string[]).filter(Boolean);
    expect(headers).not.toContain('_hasBoth');
    expect(headers).not.toContain('_qualityTier');
  });

  it('sorts Tier 1 leads before Tier 2/3 leads', async () => {
    const tier2 = makeLead({
      businessName: 'Email Only Co',
      phone: '',
      _hasBoth: false,
      _qualityTier: 'Tier2' as QualityTier,
    });
    const tier1 = makeLead({
      businessName: 'Both Contact Ltd',
      _hasBoth: true,
      _qualityTier: 'Tier1' as QualityTier,
    });
    const tier3 = makeLead({
      businessName: 'Phone Only Inc',
      email: '',
      _hasBoth: false,
      _qualityTier: 'Tier3' as QualityTier,
    });

    const buf = await generateExcelBuffer([tier2, tier3, tier1]);
    const ws = await parseBuffer(buf);

    // Row 1 is header, data starts at row 2. Column 1 = Business Name.
    const row2Name = ws.getRow(2).getCell(1).value as string;
    expect(row2Name).toBe('Both Contact Ltd');
  });

  it('handles empty leads array without throwing', async () => {
    const buf = await generateExcelBuffer([]);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const ws = await parseBuffer(buf);
    // Only header row should exist
    expect(ws.rowCount).toBe(1);
  });

  it('writes empty string for missing email/phone (not null or undefined)', async () => {
    const lead = makeLead({ email: '', phone: '', _hasBoth: false, _qualityTier: 'Tier3' as QualityTier });
    const buf = await generateExcelBuffer([lead]);
    const ws = await parseBuffer(buf);
    const row = ws.getRow(2);
    // Column 2 = Email, Column 3 = Phone
    expect(row.getCell(2).value).toBe('');
    expect(row.getCell(3).value).toBe('');
  });

  it('does not mutate the input leads array', async () => {
    const leads = [
      makeLead({ businessName: 'A', _hasBoth: false, _qualityTier: 'Tier2' as QualityTier }),
      makeLead({ businessName: 'B', _hasBoth: true }),
    ];
    const originalOrder = leads.map((l) => l.businessName);
    await generateExcelBuffer(leads);
    expect(leads.map((l) => l.businessName)).toEqual(originalOrder);
  });
});

describe('shouldUseStreaming()', () => {
  it('returns false for 0 leads', () => {
    expect(shouldUseStreaming(0)).toBe(false);
  });

  it('returns false for 500 leads (at threshold)', () => {
    expect(shouldUseStreaming(500)).toBe(false);
  });

  it('returns true for 501 leads (above threshold)', () => {
    expect(shouldUseStreaming(501)).toBe(true);
  });

  it('returns true for large lead counts', () => {
    expect(shouldUseStreaming(10_000)).toBe(true);
  });
});

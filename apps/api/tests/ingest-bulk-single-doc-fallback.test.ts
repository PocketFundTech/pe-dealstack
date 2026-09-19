/**
 * POST /api/ingest/bulk receives EVERY spreadsheet uploaded in "new deal"
 * mode (IngestDealForm routes isExcel → /bulk). A financial model / CIM
 * workbook has no "Company" column, so the bulk parser finds zero rows.
 * Instead of the misleading "No valid deals found… Ensure you have a column
 * named Company" error, the route must hand the file to the single-document
 * ingest pipeline (which already supports Excel via excelFinancialExtractor).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import XLSX from 'xlsx';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/emailParser.js', () => ({ parseEmailFile: vi.fn() }));
vi.mock('../src/services/dealMerger.js', () => ({ getIconForIndustry: () => 'briefcase' }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: vi.fn() } }));
vi.mock('../src/services/firmTeaserService.js', () => ({ generateTeasersForDeal: vi.fn(async () => {}) }));
vi.mock('../src/integrations/gmail/autoCreateDeal.js', () => ({ createDealFromEmail: vi.fn() }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return { extractTextFromPDF: vi.fn(), upload: multer({ storage: multer.memoryStorage() }) };
});

const runIngestFromBuffer = vi.fn();
vi.mock('../src/routes/ingest-upload.js', async () => {
  const express = (await import('express')).default;
  return { default: express.Router(), runIngestFromBuffer };
});

function workbook(rows: any[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function buildApp() {
  const { default: router } = await import('../src/routes/ingest-email.js');
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: 'u1', organizationId: 'org-A' }; next(); });
  app.use('/api/ingest', router);
  return app;
}

describe('POST /api/ingest/bulk — no deal-list columns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runIngestFromBuffer.mockResolvedValue({ status: 201, body: { success: true, deal: { id: 'deal-1', name: 'Acme' } } });
  });

  it('falls back to single-document ingest for a financial-model workbook', async () => {
    const app = await buildApp();
    const buf = workbook([
      ['Income Statement', 'FY2023', 'FY2024', 'FY2025'],
      ['Revenue', 40.1, 44.0, 48.2],
      ['EBITDA', 7.2, 8.0, 9.1],
    ]);

    const res = await request(app)
      .post('/api/ingest/bulk')
      .attach('file', buf, { filename: 'acme-model.xlsx', contentType: XLSX_MIME });

    expect(runIngestFromBuffer).toHaveBeenCalledTimes(1);
    expect(runIngestFromBuffer.mock.calls[0][0]).toMatchObject({ mimeType: XLSX_MIME, documentName: 'acme-model.xlsx' });
    expect(res.status).toBe(201);
    expect(res.body.deal.id).toBe('deal-1');
  });

  it('does not touch single-document ingest when the sheet IS a deal list', async () => {
    mockSupabase.from.mockImplementation(() => {
      const chain: any = {};
      for (const m of ['select', 'ilike', 'eq', 'insert']) chain[m] = () => chain;
      chain.single = async () => ({ data: { id: 'x', name: 'Foo Co' }, error: null });
      return chain;
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest/bulk')
      .attach('file', workbook([['Company', 'Industry'], ['Foo Co', 'SaaS']]), { filename: 'deals.xlsx', contentType: XLSX_MIME });

    expect(runIngestFromBuffer).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.body.summary.total).toBe(1);
  });
});

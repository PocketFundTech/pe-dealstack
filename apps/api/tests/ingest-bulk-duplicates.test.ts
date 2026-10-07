/**
 * POST /api/ingest/bulk must not double the pipeline when a deal list is
 * re-imported (5 Oct testing, item 8): rows for a company with a live deal,
 * or repeated within the file, are skipped and reported.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import XLSX from 'xlsx';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSupabaseFrom = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: { from: (...args: any[]) => mockSupabaseFrom(...args), storage: { from: () => ({}) } },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/emailParser.js', () => ({ parseEmailFile: vi.fn() }));
vi.mock('../src/services/dealMerger.js', () => ({ getIconForIndustry: () => 'briefcase' }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: vi.fn(async () => {}) } }));
vi.mock('../src/integrations/gmail/autoCreateDeal.js', () => ({ createDealFromEmail: vi.fn() }));
vi.mock('../src/routes/ingest-upload.js', async () => {
  const express = (await import('express')).default;
  return { default: express.Router(), runIngestFromBuffer: vi.fn() };
});
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return {
    extractTextFromPDF: vi.fn(),
    upload: multer({ storage: multer.memoryStorage() }),
    resolveUploadedFile: async (req: any) =>
      req.file
        ? { file: { buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size } }
        : { file: null },
    cleanupStagingObject: async () => {},
  };
});

vi.mock('../src/services/firmTeaserService.js', () => ({ generateTeasersForDeal: vi.fn(async () => {}) }));

const liveDeals = new Map<string, { id: string; name: string }>();
const loadLiveDealIndex = vi.fn(async () => liveDeals);
vi.mock('../src/services/dealDuplicates.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/dealDuplicates.js')>()),
  loadLiveDealIndex: (...a: any[]) => loadLiveDealIndex(...(a as [])),
}));

const insertedDeals: any[] = [];
function mockTables() {
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'Company') {
      return {
        select: () => ({ eq: async () => ({ data: [] }) }),
        insert: (rows: any[]) => ({
          select: async () => ({ data: rows.map((r, i) => ({ id: `co-${i}`, name: r.name })), error: null }),
        }),
      };
    }
    if (table === 'Deal') {
      return {
        insert: (rows: any[]) => ({
          select: async () => {
            insertedDeals.push(...rows);
            return { data: rows.map((_, i) => ({ id: `deal-${i}` })), error: null };
          },
        }),
      };
    }
    return { select: vi.fn(), insert: vi.fn() };
  });
}

function excelBuffer(names: string[]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([['Company Name', 'Industry'], ...names.map((n) => [n, 'Tech'])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

async function post(names: string[], fields: Record<string, string> = {}) {
  const { default: router } = await import('../src/routes/ingest-email.js');
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: 'u1', organizationId: 'org-A' }; next(); });
  app.use('/api/ingest', router);
  let r = request(app).post('/api/ingest/bulk');
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', excelBuffer(names), { filename: 'deals.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

beforeEach(() => {
  vi.clearAllMocks();
  liveDeals.clear();
  insertedDeals.length = 0;
  mockTables();
});

describe('POST /api/ingest/bulk — duplicate deals (5 Oct testing, item 8)', () => {
  it('skips rows for a company that already has a live deal, whatever the suffix / case', async () => {
    liveDeals.set('strong ready mix', { id: 'd-srm', name: 'Strong Ready Mix' });
    const res = await post(['STRONG READY MIX LTD', 'Beta Corp']);
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ total: 2, imported: 1, skipped: 1 });
    expect(res.body.summary.skippedDeals[0]).toMatchObject({ reason: 'existing_deal', existingDeal: { id: 'd-srm' } });
    expect(insertedDeals.map((d) => d.name)).toEqual(['Beta Corp']);
  });

  it('imports a company only once when the file repeats it', async () => {
    const res = await post(['Acme Inc', 'Acme, Inc.', 'Gamma']);
    expect(res.body.summary).toMatchObject({ total: 3, imported: 2, skipped: 1 });
    expect(res.body.summary.skippedDeals[0]).toMatchObject({ companyName: 'Acme, Inc.', reason: 'duplicate_row' });
  });

  it('forceCreate imports every row and skips the lookup', async () => {
    liveDeals.set('acme', { id: 'd-acme', name: 'Acme' });
    const res = await post(['Acme', 'Acme'], { forceCreate: 'true' });
    expect(res.body.summary).toMatchObject({ imported: 2, skipped: 0 });
    expect(loadLiveDealIndex).not.toHaveBeenCalled();
  });
});

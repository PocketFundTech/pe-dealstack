/**
 * POST /api/ingest/bulk — firm teasers are generated on demand (Generate
 * teasers button, POST /deals/:id/teasers), never automatically per imported
 * row (#206: upload paths no longer fire background AI jobs).
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

// Track concurrency + timing so we can prove: (a) exactly one background job
// is scheduled (not one per row), and (b) at most 3 teaser calls run at once.
let inFlight = 0;
let maxInFlight = 0;
const dealIdsCalled: string[] = [];
const generateTeasersForDeal = vi.fn(async ({ dealId }: { dealId: string }) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  dealIdsCalled.push(dealId);
  await new Promise((r) => setTimeout(r, 10));
  inFlight--;
});
vi.mock('../src/services/firmTeaserService.js', () => ({
  generateTeasersForDeal: (...args: any[]) => generateTeasersForDeal(...(args as [any])),
}));

function excelBuffer(rows: number): Buffer {
  const header = ['Company Name', 'Industry', 'Revenue', 'EBITDA'];
  const data = Array.from({ length: rows }, (_, i) => [`Company ${i}`, 'Tech', 10, 2]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function mockTables() {
  let dealCounter = 0;
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'Company') {
      return {
        select: () => ({ eq: async () => ({ data: [] }) }), // no existing companies
        insert: (rows: any[]) => ({
          select: async () => ({
            data: rows.map((r, i) => ({ id: `co-${dealCounter + i}`, name: r.name })),
            error: null,
          }),
        }),
      };
    }
    if (table === 'Deal') {
      return {
        insert: (rows: any[]) => ({
          select: async () => {
            const inserted = rows.map(() => ({ id: `deal-${dealCounter++}` }));
            return { data: inserted, error: null };
          },
        }),
      };
    }
    return { select: vi.fn(), insert: vi.fn() };
  });
}

interface AppOptions {
  withAfterResponseHook: boolean;
}

function buildApp({ withAfterResponseHook }: AppOptions) {
  const scheduled: Array<() => void | Promise<void>> = [];
  const appPromise = (async () => {
    const { default: router } = await import('../src/routes/ingest-email.js');
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { id: 'u1', organizationId: 'org-A' };
      if (withAfterResponseHook) {
        req.runAfterResponse = (fn: () => void | Promise<void>) => scheduled.push(fn);
      }
      next();
    });
    app.use('/api/ingest', router);
    return app;
  })();
  return { appPromise, scheduled };
}

beforeEach(() => {
  vi.clearAllMocks();
  inFlight = 0;
  maxInFlight = 0;
  dealIdsCalled.length = 0;
  mockTables();
});

describe('POST /api/ingest/bulk — teasers are on demand (#206)', () => {
  it('imports every row without generating teasers or scheduling background AI work', async () => {
    const { appPromise, scheduled } = buildApp({ withAfterResponseHook: true });
    const app = await appPromise;

    const res = await request(app)
      .post('/api/ingest/bulk')
      .attach('file', excelBuffer(8), { filename: 'deals.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    expect(res.status).toBe(201);
    expect(res.body.summary.imported).toBe(8);
    expect(scheduled.length).toBe(0);
    expect(generateTeasersForDeal).not.toHaveBeenCalled();
  });
});

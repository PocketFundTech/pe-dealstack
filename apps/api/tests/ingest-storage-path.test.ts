/**
 * JSON `{ storagePath, ... }` ingest — the server-side half of the
 * large-upload fix: the browser stages a file directly to Supabase Storage
 * via POST /api/uploads/sign, then calls POST /api/ingest with a JSON body
 * pointing at it instead of the file bytes (Vercel rejects any request body
 * over 4.5MB before the app runs, so a large CIM can never reach this route
 * as multipart). Covers ingest-shared.ts#resolveUploadedFile directly, and
 * the POST /api/ingest route wired up to it: cross-org storagePath is
 * rejected, a same-org storagePath is downloaded and run through the
 * existing pipeline unchanged, the staging object is deleted after the
 * response, and legacy multipart uploads keep working untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const download = vi.fn();
const remove = vi.fn(async () => ({ data: null, error: null }));
// The one supabase mock for this file is further down (it needs `from` for
// the route-level tests). A second vi.mock of the same path here made the
// route tests flaky: whichever factory won, the route sometimes got a client
// with no `from` and 500'd ("supabase.from is not a function").

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => {
    if (!req.user?.organizationId) throw new Error('Organization ID not available');
    return req.user.organizationId;
  },
  verifyDealAccess: vi.fn(),
}));

// ─── Unit-level tests: resolveUploadedFile ────────────────────────────────

describe('resolveUploadedFile (ingest-shared.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers a multipart req.file when present, ignoring any JSON body', async () => {
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = {
      user: { organizationId: 'org-A' },
      file: { buffer: Buffer.from('hello'), originalname: 'a.pdf', mimetype: 'application/pdf', size: 5 },
      body: { storagePath: 'staging/org-A/xyz/should-be-ignored.pdf' },
    };
    const result = await resolveUploadedFile(req);
    expect(result.file?.originalname).toBe('a.pdf');
    expect(result.cleanupStoragePath).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  it('returns file: null with no error when neither req.file nor storagePath is present', async () => {
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = { user: { organizationId: 'org-A' }, body: {} };
    const result = await resolveUploadedFile(req);
    expect(result.file).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('403s a storagePath that does not start with the caller org prefix', async () => {
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = {
      user: { organizationId: 'org-A' },
      body: { storagePath: 'staging/org-B/some-uuid/cim.pdf', fileName: 'cim.pdf', mimeType: 'application/pdf', size: 100 },
    };
    const result = await resolveUploadedFile(req);
    expect(result.file).toBeNull();
    expect(result.error?.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ['a ../ traversal into another org', 'staging/org-A/../org-B/some-uuid/cim.pdf'],
    ['a traversal from the id segment', 'staging/org-A/abc/../../org-B/x/cim.pdf'],
    ['extra folder levels', 'staging/org-A/abc/nested/cim.pdf'],
    ['an empty segment', 'staging/org-A//cim.pdf'],
    ['a backslash', 'staging/org-A/abc/..\\org-B.pdf'],
    ['a dot-dot filename', 'staging/org-A/abc/..'],
  ])('403s a storagePath with %s even though it starts with the org prefix', async (_label, storagePath) => {
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = { user: { organizationId: 'org-A' }, body: { storagePath, fileName: 'cim.pdf', mimeType: 'application/pdf', size: 100 } };
    const result = await resolveUploadedFile(req);
    expect(result.file).toBeNull();
    expect(result.error?.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads and resolves a same-org storagePath', async () => {
    download.mockResolvedValueOnce({ data: { arrayBuffer: async () => new TextEncoder().encode('PDF-BYTES').buffer }, error: null });
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = {
      user: { organizationId: 'org-A' },
      body: {
        storagePath: 'staging/org-A/uuid-1/cim.pdf',
        fileName: 'cim.pdf',
        mimeType: 'application/pdf',
        size: 9,
      },
    };
    const result = await resolveUploadedFile(req);
    expect(result.error).toBeUndefined();
    expect(result.file?.originalname).toBe('cim.pdf');
    expect(result.file?.mimetype).toBe('application/pdf');
    expect(result.file?.buffer.toString()).toBe('PDF-BYTES');
    expect(result.cleanupStoragePath).toBe('staging/org-A/uuid-1/cim.pdf');
    expect(download).toHaveBeenCalledWith('staging/org-A/uuid-1/cim.pdf');
  });

  it('400s when the storage download fails (e.g. expired/missing object)', async () => {
    download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });
    const { resolveUploadedFile } = await import('../src/routes/ingest-shared.js');
    const req: any = {
      user: { organizationId: 'org-A' },
      body: { storagePath: 'staging/org-A/uuid-1/cim.pdf' },
    };
    const result = await resolveUploadedFile(req);
    expect(result.file).toBeNull();
    expect(result.error?.status).toBe(400);
  });
});

// ─── Route-level tests: POST /api/ingest ──────────────────────────────────
//
// Exercises the REAL runIngestFromBuffer (it's a plain function declared in
// ingest-upload.ts, so it can't be mocked out from outside that module) end
// to end, with its downstream AI/DB dependencies stubbed — same approach as
// tests/ingest-upload-security.test.ts. What's under test here is the
// storagePath resolution + cleanup wiring in the POST / handler, not the
// extraction pipeline itself.

const mockSupabaseFrom = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (...args: any[]) => mockSupabaseFrom(...args),
    storage: { from: () => ({ download, remove, upload: async () => ({ data: { path: 'x' }, error: null }) }) },
  },
}));

vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal: vi.fn(),
  getIconForIndustry: () => 'briefcase',
}));
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText: async () => ({
    companyName: { value: 'Acme Corp', confidence: 90 },
    industry: { value: 'Healthcare', confidence: 80 },
    description: { value: 'Test', confidence: 90 },
    currency: 'USD',
    revenue: { value: 50, confidence: 90 },
    ebitda: { value: 10, confidence: 90 },
    ebitdaMargin: { value: 20, confidence: 90 },
    dealSize: { value: null, confidence: 0 },
    revenueGrowth: { value: 15, confidence: 80 },
    employees: { value: 500, confidence: 70 },
    foundedYear: { value: null, confidence: 0 },
    headquarters: { value: null, confidence: 0 },
    keyRisks: [],
    investmentHighlights: [],
    summary: 'test',
    overallConfidence: 85,
    needsReview: false,
    reviewReasons: [],
  }),
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn(async () => ({ success: true, chunkCount: 1 })) }));
vi.mock('../src/services/documentDedup.js', () => ({
  findExistingDocument: vi.fn(async () => null),
  logDuplicateSkip: vi.fn(),
}));
vi.mock('../src/services/firmTeaserService.js', () => ({ generateTeasersForDeal: vi.fn(async () => {}) }));
vi.mock('../src/services/documentParser.js', () => ({ extractTextFromWord: vi.fn() }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({ extractTextFromExcel: vi.fn(), isExcelFile: () => false }));
vi.mock('../src/services/langExtractClient.js', () => ({ deepExtract: vi.fn(), isDeepExtractionAvailable: () => false }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: vi.fn(), aiIngest: vi.fn(async () => {}) } }));
vi.mock('../src/services/financialValidator.js', () => ({ validateFinancials: () => ({ isValid: true, warnings: [] }) }));
vi.mock('../src/routes/notifications.js', () => ({ resolveUserId: vi.fn(async () => null) }));
vi.mock('../src/services/ingestDeepPass.js', () => ({
  shouldRunIngestDeepPass: () => false,
  runIngestDeepPass: vi.fn(),
}));
vi.mock('../src/utils/background.js', () => ({ runInBackground: vi.fn() }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

// Keep the real resolveUploadedFile/cleanupStagingObject (that's what's
// under test), only stub the PDF text layer.
vi.mock('../src/routes/ingest-shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/routes/ingest-shared.js')>();
  return {
    ...actual,
    extractTextFromPDF: async () => ({ text: 'A'.repeat(500), numPages: 1, source: 'pdf-parse', sparse: false }),
  };
});

function mockDealTables() {
  mockSupabaseFrom.mockImplementation((table: string) => {
    if (table === 'Company') {
      return {
        select: () => ({ ilike: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }), limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'co-1', name: 'Acme Corp' }, error: null }) }) }),
      };
    }
    if (table === 'Deal') {
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'deal-1', name: 'Acme Corp' }, error: null }) }) }),
      };
    }
    if (table === 'Folder') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) };
    }
    if (table === 'Document') {
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'doc-1', name: 'cim.pdf' }, error: null }) }) }),
        select: () => ({ eq: async () => ({ count: 1 }) }),
      };
    }
    if (table === 'Activity' || table === 'DealTeamMember') {
      return { insert: async () => ({ error: null }) };
    }
    return { select: vi.fn(), insert: vi.fn() };
  });
}

async function buildIngestApp() {
  const { default: router } = await import('../src/routes/ingest-upload.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'u1', organizationId: 'org-A' };
    next();
  });
  app.use('/api/ingest', router);
  return app;
}

describe('POST /api/ingest — storagePath JSON body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDealTables();
  });

  it('rejects a storagePath from another org with 403 and never runs the pipeline', async () => {
    const app = await buildIngestApp();
    const res = await request(app)
      .post('/api/ingest')
      .send({ storagePath: 'staging/org-B/uuid/cim.pdf', fileName: 'cim.pdf', mimeType: 'application/pdf', size: 10 });

    expect(res.status).toBe(403);
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads a same-org storagePath and runs the existing ingest pipeline', async () => {
    download.mockResolvedValueOnce({ data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 test').buffer }, error: null });
    const app = await buildIngestApp();
    const res = await request(app).post('/api/ingest').send({
      storagePath: 'staging/org-A/uuid/cim.pdf',
      fileName: 'cim.pdf',
      mimeType: 'application/pdf',
      size: 13,
    });

    expect(res.status).toBe(201);
    expect(res.body.deal.id).toBe('deal-1');
  });

  it('deletes the staging object after the response (via runAfterResponse)', async () => {
    download.mockResolvedValueOnce({ data: { arrayBuffer: async () => new TextEncoder().encode('x').buffer }, error: null });
    const app = await buildIngestApp();
    const res = await request(app).post('/api/ingest').send({
      storagePath: 'staging/org-A/uuid/cim.pdf',
      fileName: 'cim.pdf',
      mimeType: 'application/pdf',
      size: 1,
    });

    expect(res.status).toBe(201);
    // No post-response hook attached in this test app, so runAfterResponse
    // awaits cleanup inline before the request completes.
    expect(remove).toHaveBeenCalledWith(['staging/org-A/uuid/cim.pdf']);
  });

  it('still accepts a legacy multipart upload unchanged, without touching storage download/remove', async () => {
    const app = await buildIngestApp();
    const res = await request(app)
      .post('/api/ingest')
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

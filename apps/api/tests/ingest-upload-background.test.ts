/**
 * Covers the "everything but the AI deal read leaves the wait" fix for
 * POST /api/ingest (runIngestFromBuffer in ingest-upload.ts). The founder
 * kept the ~30s Fable deal read blocking (the modal shows extracted results
 * before the deal exists), but RAG embedding, the Activity/audit-log rows,
 * the multi-doc-analysis trigger, and firm-teaser generation must never add
 * latency to the response.
 *
 * Whenever the Express request carries a `runAfterResponse` hook (attached
 * by the Next.js proxy adapter via next/server's `after()`), the handler
 * responds immediately after the Document/DealTeamMember rows exist, then
 * runs that background work via the hook. Without the hook (local dev via
 * app.ts, tests, non-Vercel deploys) it must behave exactly as before:
 * fully synchronous, response only sent after every step completes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Webhook delivery schedules its own after-response job; out of scope here.
vi.mock('../src/services/outboundWebhooks.js', () => ({ emitWebhookEvent: vi.fn() }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSupabaseFrom = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (...args: any[]) => mockSupabaseFrom(...args),
    storage: { from: () => ({ upload: async () => ({ data: { path: 'x' }, error: null }) }) },
  },
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess: vi.fn(),
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

// Resolve deliberately slowly and observably so tests can prove the
// response does (or doesn't) wait for each one.
let embedResolved = false;
const embedDocument = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 15));
  embedResolved = true;
  return { success: true, chunkCount: 2 };
});
vi.mock('../src/rag.js', () => ({ embedDocument: (...args: any[]) => embedDocument(...args) }));

let auditResolved = false;
const auditAiIngest = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 15));
  auditResolved = true;
});
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiIngest: (...args: any[]) => auditAiIngest(...args) } }));

let teaserResolved = false;
const generateTeasersForDeal = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 15));
  teaserResolved = true;
});
vi.mock('../src/services/firmTeaserService.js', () => ({
  generateTeasersForDeal: (...args: any[]) => generateTeasersForDeal(...args),
}));

vi.mock('../src/services/documentDedup.js', () => ({
  findExistingDocument: vi.fn(async () => null),
  logDuplicateSkip: vi.fn(),
}));
vi.mock('../src/services/documentParser.js', () => ({ extractTextFromWord: vi.fn() }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({ extractTextFromExcel: vi.fn(), isExcelFile: () => false }));
vi.mock('../src/services/langExtractClient.js', () => ({ deepExtract: vi.fn(), isDeepExtractionAvailable: () => false }));
vi.mock('../src/services/financialValidator.js', () => ({ validateFinancials: () => ({ isValid: true, warnings: [] }) }));
vi.mock('../src/routes/notifications.js', () => ({ resolveUserId: vi.fn(async () => 'internal-user-1') }));
vi.mock('../src/services/ingestDeepPass.js', () => ({ shouldRunIngestDeepPass: () => false, runIngestDeepPass: vi.fn() }));
const runInBackground = vi.fn();
vi.mock('../src/utils/background.js', () => ({ runInBackground: (...a: any[]) => runInBackground(...a) }));
const maybeScoreAfterExtraction = vi.fn(async () => {});
vi.mock('../src/services/agents/dealScorecard/index.js', () => ({
  maybeScoreAfterExtraction: (...a: any[]) => maybeScoreAfterExtraction(...a),
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return {
    extractTextFromPDF: async () => ({ text: 'A'.repeat(500), numPages: 1, source: 'pdf-parse', sparse: false }),
    upload: multer({ storage: multer.memoryStorage() }),
    resolveUploadedFile: async (req: any) =>
      req.file
        ? { file: { buffer: req.file.buffer, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size } }
        : { file: null },
    cleanupStagingObject: async () => {},
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

interface AppOptions {
  withAfterResponseHook: boolean;
}

function buildApp({ withAfterResponseHook }: AppOptions) {
  const scheduled: Array<() => void | Promise<void>> = [];

  const appPromise = (async () => {
    const { default: router } = await import('../src/routes/ingest-upload.js');
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      if (withAfterResponseHook) {
        req.runAfterResponse = (fn: () => void | Promise<void>) => {
          scheduled.push(fn);
        };
      }
      next();
    });
    app.use('/api/ingest', router);
    return app;
  })();

  return { appPromise, scheduled };
}

const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf bytes for test'.repeat(5));

beforeEach(() => {
  vi.clearAllMocks();
  embedResolved = false;
  auditResolved = false;
  teaserResolved = false;
  mockDealTables();
});

describe('POST /api/ingest — background work (embed, audit log, teasers)', () => {
  it('responds before embed/audit/teasers resolve when a runAfterResponse hook is present, then runs them in the background', async () => {
    const { appPromise, scheduled } = buildApp({ withAfterResponseHook: true });
    const app = await appPromise;

    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.deal.id).toBe('deal-1');

    // Nothing deferred has run yet.
    expect(embedResolved).toBe(false);
    expect(auditResolved).toBe(false);
    expect(teaserResolved).toBe(false);
    expect(generateTeasersForDeal).not.toHaveBeenCalled();

    // Exactly one background job (embed/audit) is scheduled; teasers are on demand.
    expect(scheduled.length).toBe(1);

    await scheduled[0]();

    expect(embedResolved).toBe(true);
    expect(auditResolved).toBe(true);
    expect(generateTeasersForDeal).not.toHaveBeenCalled();
  });

  it('without a runAfterResponse hook, awaits everything inline before responding (legacy behavior)', async () => {
    const { appPromise, scheduled } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;

    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(scheduled.length).toBe(0);
    expect(embedResolved).toBe(true);
    expect(auditResolved).toBe(true);
    expect(generateTeasersForDeal).not.toHaveBeenCalled();
  });

  it('a PDF ingest starts no AI deep pass, scoring, or teaser work on upload', async () => {
    runInBackground.mockClear();
    maybeScoreAfterExtraction.mockClear();
    const { appPromise } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;
    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(runInBackground.mock.calls.map((c: any[]) => c[0])).toEqual([]);
    expect(maybeScoreAfterExtraction).not.toHaveBeenCalled();
    expect(generateTeasersForDeal).not.toHaveBeenCalled();
  });
});

/**
 * Covers the fix for "upload takes a very long time": handleDocumentUpload
 * used to `await extractDealDataFromText(...)` (an LLM call) before ever
 * responding to the client. Now, whenever the Express request carries a
 * `runAfterResponse` hook (attached by the Next.js proxy adapter via
 * next/server's `after()` — see apps/web-next/src/lib/api-adapter.ts and
 * apps/api/src/utils/afterResponse.ts), the handler:
 *   1. inserts the Document row with status 'processing'
 *   2. responds 201 immediately, WITHOUT waiting on the AI extraction
 *   3. runs the AI extraction + deal merge + RAG embed via the hook
 *
 * Without the hook (local dev via app.ts, Render, tests that don't attach
 * it), the handler must behave exactly as it always did: fully synchronous,
 * response only sent after every step (including AI extraction) completes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────

const mockSupabase = { from: vi.fn(), storage: { from: vi.fn() } };
// Webhook delivery schedules its own after-response job; out of scope here.
vi.mock('../src/services/outboundWebhooks.js', () => ({ emitWebhookEvent: vi.fn() }));

vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess: (...args: any[]) => verifyDealAccess(...args),
}));

vi.mock('../src/services/fileValidator.js', () => ({
  validateFile: () => ({ isValid: true, sanitizedFilename: 'cim.pdf' }),
  sanitizeFilename: (n: string) => n,
  isPotentiallyDangerous: () => false,
  ALLOWED_MIME_TYPES: ['application/pdf'],
}));

const auditLogDocumentUploaded = vi.fn(async () => {});
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { documentUploaded: (...args: any[]) => auditLogDocumentUploaded(...args) },
  logFromRequest: vi.fn(async () => {}),
  AUDIT_ACTIONS: { DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED' },
  RESOURCE_TYPES: { DOCUMENT: 'DOCUMENT' },
  SEVERITY: { WARNING: 'WARNING' },
}));

vi.mock('../src/services/aiCache.js', () => ({ AICache: { invalidate: vi.fn(async () => {}) } }));

const notifyDealTeam = vi.fn();
const resolveUserId = vi.fn(async () => 'internal-user-1');
vi.mock('../src/routes/notifications.js', () => ({
  notifyDealTeam: (...args: any[]) => notifyDealTeam(...args),
  resolveUserId: (...args: any[]) => resolveUserId(...(args as [string])),
}));

const extractTextFromPDF = vi.fn(async () => ({ text: 'A'.repeat(200), numPages: 3 }));
vi.mock('../src/services/pdfExtractor.js', () => ({
  extractTextFromPDF: (...args: any[]) => extractTextFromPDF(...args),
}));

vi.mock('../src/services/agents/financialAgent/concurrency.js', () => ({
  acquireExtractionSlot: () => true,
  acquireExtractionSlotBy: async () => true,
  releaseExtractionSlot: () => {},
}));

vi.mock('../src/services/documentDedup.js', () => ({
  findExistingDocument: vi.fn(async () => null),
  logDuplicateSkip: vi.fn(),
}));

vi.mock('../src/integrations/_platform/tokenStore.js', () => ({
  getProviderAccessToken: vi.fn(async () => null),
}));
vi.mock('../src/integrations/googleDrive/client.js', () => ({
  getDriveFileMetadata: vi.fn(),
  downloadDriveFile: vi.fn(),
  exportDriveFile: vi.fn(),
  isGoogleNativeMime: () => false,
  driveExportTargetFor: () => null,
}));
vi.mock('../src/integrations/googleDrive/types.js', () => ({
  GoogleDriveError: class GoogleDriveError extends Error {},
}));

// Let AI extraction resolve deliberately slowly and observably, so tests
// can prove the response does (or doesn't) wait for it.
let aiExtractionResolved = false;
const extractDealDataFromText = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 20));
  aiExtractionResolved = true;
  return {
    companyName: 'Acme Corp',
    industry: 'Healthcare',
    revenue: 50,
    ebitda: 10,
  };
});
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText: (...args: any[]) => extractDealDataFromText(...args),
}));

const readDealDocument = vi.fn(async (): Promise<any> => null);
vi.mock('../src/services/extraction/claudeDealReader.js', () => ({
  readDealDocument: (...args: any[]) => readDealDocument(...args),
}));

const embedDocument = vi.fn(async () => ({ success: true, chunkCount: 3 }));
vi.mock('../src/rag.js', () => ({ embedDocument: (...args: any[]) => embedDocument(...args) }));

const tryCompleteOnboardingStep = vi.fn(async () => {});
vi.mock('../src/routes/onboarding.js', () => ({
  tryCompleteOnboardingStep: (...args: any[]) => tryCompleteOnboardingStep(...args),
}));

vi.mock('../src/services/excelToMarkdown.js', () => ({ excelToMarkdown: vi.fn() }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({ isExcelFile: () => false }));
vi.mock('../src/services/financialExtractionOrchestrator.js', () => ({ runDeepPass: vi.fn() }));

// ─── Test app builder ───────────────────────────────────────────────────

interface AppOptions {
  withAfterResponseHook: boolean;
}

// Collects functions scheduled via req.runAfterResponse so the test can
// await them explicitly once the request/response cycle is done — mirrors
// what next/server's after() does (runs after the response, kept alive by
// the caller), without depending on Next.js itself.
function buildApp({ withAfterResponseHook }: AppOptions) {
  const scheduled: Array<() => void | Promise<void>> = [];

  const appPromise = (async () => {
    const { default: router } = await import('../src/routes/documents-upload.js');
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
    app.use('/api', router);
    return app;
  })();

  return { appPromise, scheduled };
}

function mockDealTable() {
  // Document insert + update, Folder select/insert, Deal update, Activity insert.
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'Document') {
      const single = vi.fn(async () => ({
        data: {
          id: 'doc-1',
          dealId: 'deal-1',
          name: 'cim.pdf',
          type: 'CIM',
          status: 'processing',
        },
        error: null,
      }));
      return {
        insert: () => ({ select: () => ({ single }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === 'Folder') {
      return {
        select: () => ({
          eq: () => ({ order: async () => ({ data: [{ id: 'folder-1', name: '100 Financials' }] }) }),
        }),
      };
    }
    if (table === 'Deal') {
      return { update: () => ({ eq: async () => ({ data: null, error: null }) }) };
    }
    if (table === 'Activity') {
      return { insert: async () => ({ error: null }) };
    }
    return { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
  });
  mockSupabase.storage.from.mockReturnValue({
    upload: async () => ({ data: { path: 'deal-1/file.pdf' }, error: null }),
  });
}

const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf bytes for test'.repeat(5));

beforeEach(() => {
  vi.clearAllMocks();
  aiExtractionResolved = false;
  verifyDealAccess.mockResolvedValue({ id: 'deal-1', organizationId: 'org-A' });
  mockDealTable();
});

describe('POST /api/deals/:dealId/documents — background AI extraction', () => {
  it('responds before extractDealDataFromText resolves when a runAfterResponse hook is present, then runs it in the background', async () => {
    const { appPromise, scheduled } = buildApp({ withAfterResponseHook: true });
    const app = await appPromise;

    const res = await request(app)
      .post('/api/deals/deal-1/documents')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    // The response must have been sent BEFORE the AI extraction resolved.
    expect(aiExtractionResolved).toBe(false);
    expect(res.body.status).toBe('processing');
    expect(res.body.dealUpdated).toBe(false);

    // Exactly one job was scheduled via the hook, and it hasn't run yet.
    expect(scheduled.length).toBe(1);
    expect(extractDealDataFromText).not.toHaveBeenCalled();

    // Now run the deferred job (what next/server's after() would do).
    await scheduled[0]();

    expect(extractDealDataFromText).toHaveBeenCalledTimes(1);
    expect(aiExtractionResolved).toBe(true);
    expect(embedDocument).toHaveBeenCalledTimes(1);
    expect(auditLogDocumentUploaded).toHaveBeenCalledTimes(1);
  });

  it('without a runAfterResponse hook, awaits AI extraction inline before responding (legacy behavior)', async () => {
    const { appPromise, scheduled } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;

    const res = await request(app)
      .post('/api/deals/deal-1/documents')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    // Nothing was deferred — the whole pipeline ran inline.
    expect(scheduled.length).toBe(0);
    expect(extractDealDataFromText).toHaveBeenCalledTimes(1);
    expect(aiExtractionResolved).toBe(true);
    expect(embedDocument).toHaveBeenCalledTimes(1);
    expect(auditLogDocumentUploaded).toHaveBeenCalledTimes(1);
  });

  it('resolves uploadedBy from the authenticated user, not a client-supplied value', async () => {
    const { appPromise } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;

    await request(app)
      .post('/api/deals/deal-1/documents')
      .field('uploadedBy', 'attacker-supplied-id')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });

    expect(resolveUserId).toHaveBeenCalledWith('auth-user-1');
  });
});

describe('POST /api/deals/:dealId/documents — deal-field read model (INGEST_ENGINE=claude)', () => {
  const saved = process.env.INGEST_ENGINE;
  beforeEach(() => { process.env.INGEST_ENGINE = 'claude'; });
  afterEach(() => { if (saved === undefined) delete process.env.INGEST_ENGINE; else process.env.INGEST_ENGINE = saved; });

  it('uses the cheap Claude reader on a capped excerpt and skips GPT-4o when it succeeds', async () => {
    readDealDocument.mockResolvedValueOnce({ companyName: 'Acme Corp', industry: 'Healthcare', revenue: 50, ebitda: 10 });
    const { appPromise } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;
    const res = await request(app)
      .post('/api/deals/deal-1/documents')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(readDealDocument).toHaveBeenCalledTimes(1);
    const arg = (readDealDocument.mock.calls[0] as any[])[0];
    expect(arg.maxTextChars).toBe(40_000);
    expect(arg.fileBuffer).toBeUndefined();
    expect(extractDealDataFromText).not.toHaveBeenCalled();
  });

  it('falls back to the legacy extractor when the Claude read returns null', async () => {
    readDealDocument.mockResolvedValueOnce(null);
    const { appPromise } = buildApp({ withAfterResponseHook: false });
    const app = await appPromise;
    const res = await request(app)
      .post('/api/deals/deal-1/documents')
      .attach('file', pdfBuffer, { filename: 'cim.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(readDealDocument).toHaveBeenCalledTimes(1);
    expect(extractDealDataFromText).toHaveBeenCalledTimes(1);
  });
});

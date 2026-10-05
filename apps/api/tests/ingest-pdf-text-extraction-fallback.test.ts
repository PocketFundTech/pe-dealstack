/**
 * Bug: uploading a valid PDF whose text layer pdf-parse 1.1.4 (bundled 2017
 * pdf.js) can't parse — e.g. modern object-stream PDFs — used to 422 with
 * "The PDF may be encrypted, password-protected, or malformed" even under
 * INGEST_ENGINE=claude, where readDealDocument (claudeDealReader.ts) reads
 * the whole PDF natively via the Files API and doesn't actually need our
 * local text layer to succeed. runIngestFromBuffer (ingest-upload.ts) was
 * bailing out with a 422 before ever attempting the native Claude read.
 *
 * Covers:
 *  a) INGEST_ENGINE=claude + text extraction throws → ingest proceeds,
 *     calls readDealDocument with the fileBuffer, and creates the deal.
 *  b) INGEST_ENGINE=claude + text extraction fails AND the native Claude
 *     read also returns null → a clear 422 that doesn't assert the PDF is
 *     encrypted/malformed as fact.
 *  c) INGEST_ENGINE unset (legacy) → unchanged: text extraction failure
 *     422s immediately, readDealDocument is never invoked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

const extractDealDataFromText = vi.fn();
vi.mock('../src/services/aiExtractor.js', () => ({ extractDealDataFromText: (...a: any[]) => extractDealDataFromText(...a) }));

const readDealDocument = vi.fn();
vi.mock('../src/services/extraction/claudeDealReader.js', () => ({
  readDealDocument: (...a: any[]) => readDealDocument(...a),
}));

vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn(async () => ({ success: true, chunkCount: 0 })) }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiIngest: vi.fn(async () => {}) } }));
vi.mock('../src/services/firmTeaserService.js', () => ({ generateTeasersForDeal: vi.fn(async () => {}) }));
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
vi.mock('../src/utils/background.js', () => ({ runInBackground: vi.fn() }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

// extractTextFromPDF throws — same failure mode as the live bug: pdf-parse's
// bundled 2017 pdf.js can't parse a modern object-stream PDF and hard-fails
// (extractTextFromPDF itself catches internally and resolves null; see
// ingest-shared.ts — we simulate that "both layers hard-failed" outcome).
const extractTextFromPDF = vi.fn(async () => null);
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return {
    extractTextFromPDF: (...a: any[]) => extractTextFromPDF(...a),
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
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'co-1', name: 'Northwind' }, error: null }) }) }),
      };
    }
    if (table === 'Deal') {
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'deal-1', name: 'Northwind' }, error: null }) }) }),
      };
    }
    if (table === 'Folder') {
      return { select: () => ({ eq: () => ({ order: async () => ({ data: [] }) }) }) };
    }
    if (table === 'Document') {
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'doc-1', name: 'Northwind-CIM.pdf' }, error: null }) }) }),
        select: () => ({ eq: async () => ({ count: 1 }) }),
      };
    }
    if (table === 'Activity' || table === 'DealTeamMember') {
      return { insert: async () => ({ error: null }) };
    }
    return { select: vi.fn(), insert: vi.fn() };
  });
}

function buildApp() {
  const appPromise = (async () => {
    const { default: router } = await import('../src/routes/ingest-upload.js');
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      // No runAfterResponse hook — synchronous test behavior.
      next();
    });
    app.use('/api/ingest', router);
    return app;
  })();
  return appPromise;
}

const pdfBuffer = Buffer.from('%PDF-1.7 modern object-stream pdf bytes'.repeat(5));

const claudeAiData = {
  companyName: { value: 'Northwind', confidence: 95 },
  industry: { value: 'Manufacturing', confidence: 85 },
  description: { value: 'A widget maker.', confidence: 90 },
  currency: 'USD',
  revenue: { value: 40, confidence: 90 },
  ebitda: { value: 8, confidence: 90 },
  ebitdaMargin: { value: 20, confidence: 90 },
  dealSize: { value: null, confidence: 0 },
  revenueGrowth: { value: 10, confidence: 80 },
  employees: { value: 120, confidence: 70 },
  foundedYear: { value: null, confidence: 0 },
  headquarters: { value: null, confidence: 0 },
  keyRisks: [],
  investmentHighlights: [],
  summary: 'test',
  overallConfidence: 88,
  needsReview: false,
  reviewReasons: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.INGEST_ENGINE;
  mockDealTables();
  extractTextFromPDF.mockResolvedValue(null);
});

describe('PDF text-extraction hard failure — INGEST_ENGINE=claude', () => {
  it('(a) proceeds via the native Claude read and creates the deal when text extraction fails', async () => {
    process.env.INGEST_ENGINE = 'claude';
    readDealDocument.mockResolvedValue(claudeAiData);

    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'Northwind-CIM.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.deal.id).toBe('deal-1');
    expect(readDealDocument).toHaveBeenCalledTimes(1);
    const callArg = readDealDocument.mock.calls[0][0];
    expect(callArg.fileBuffer).toBeInstanceOf(Buffer);
    expect(callArg.fileName).toBe('Northwind-CIM.pdf');
    // The legacy text-based extractor must never run — the native read succeeded.
    expect(extractDealDataFromText).not.toHaveBeenCalled();
  });

  it('(b) returns a clear 422 (not "encrypted/malformed") when the native Claude read also fails', async () => {
    process.env.INGEST_ENGINE = 'claude';
    readDealDocument.mockResolvedValue(null);

    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'Northwind-CIM.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
    expect(res.body.error).not.toMatch(/encrypted|malformed/i);
    expect(res.body.error).toMatch(/couldn't read this pdf/i);
    // Must not fall through to the legacy text extractor with empty text.
    expect(extractDealDataFromText).not.toHaveBeenCalled();
  });
});

describe('PDF text-extraction hard failure — legacy engine (INGEST_ENGINE unset)', () => {
  it('(c) 422s immediately with the original message; readDealDocument is never invoked', async () => {
    // INGEST_ENGINE left unset by beforeEach.
    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest')
      .attach('file', pdfBuffer, { filename: 'Northwind-CIM.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/encrypted, password-protected, or malformed/i);
    expect(readDealDocument).not.toHaveBeenCalled();
    expect(extractDealDataFromText).not.toHaveBeenCalled();
  });
});

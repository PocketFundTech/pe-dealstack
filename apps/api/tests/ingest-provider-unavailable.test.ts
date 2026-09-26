/**
 * Ingest routes must surface an AI provider rejection (billing / bad key /
 * rate limit) as 503 AI_PROVIDER_UNAVAILABLE — not as the 4xx "couldn't
 * identify any deal information" message that blames the document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const extractDealDataFromText = vi.fn();
vi.mock('../src/services/aiExtractor.js', () => ({ extractDealDataFromText }));

vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal: vi.fn(),
  getIconForIndustry: () => 'briefcase',
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/documentDedup.js', () => ({
  findExistingDocument: vi.fn(async () => null),
  logDuplicateSkip: vi.fn(),
}));
vi.mock('../src/services/firmTeaserService.js', () => ({ generateTeasersForDeal: vi.fn(async () => {}) }));
vi.mock('../src/services/documentParser.js', () => ({ extractTextFromWord: vi.fn() }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: vi.fn(),
  isExcelFile: () => false,
}));
vi.mock('../src/services/langExtractClient.js', () => ({
  deepExtract: vi.fn(),
  isDeepExtractionAvailable: () => false,
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: vi.fn(), aiIngest: vi.fn() } }));
vi.mock('../src/services/financialValidator.js', () => ({
  validateFinancials: () => ({ isValid: true, warnings: [] }),
}));
vi.mock('../src/routes/notifications.js', () => ({ resolveUserId: vi.fn() }));
vi.mock('../src/services/ingestDeepPass.js', () => ({
  runIngestDeepPass: vi.fn(),
  shouldRunIngestDeepPass: () => false,
}));
vi.mock('../src/utils/background.js', () => ({ runInBackground: vi.fn() }));
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return {
    extractTextFromPDF: async () => ({ text: 'A'.repeat(500), numPages: 1, source: 'pdf-parse', sparse: false }),
    upload: multer({ storage: multer.memoryStorage() }),
  };
});
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess: vi.fn(),
}));

const TEXT = 'Acme Corp is a manufacturer with FY2025 revenue of $48.2 million and EBITDA of $9.1 million. '.repeat(3);

async function quotaRejection() {
  const { AIProviderUnavailableError } = await import('../src/utils/aiErrors.js');
  return new AIProviderUnavailableError('openai', { reason: 'quota', detail: 'You have no credits remaining.' });
}

describe('ingest routes surface provider rejection as 503', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.INGEST_ENGINE = 'legacy';
    extractDealDataFromText.mockRejectedValue(await quotaRejection());
  });

  it('POST /api/ingest (file upload) → 503 AI_PROVIDER_UNAVAILABLE', async () => {
    const { default: router } = await import('../src/routes/ingest-upload.js');
    const app = express();
    app.use((req: any, _res, next) => { req.user = { id: 'u1', organizationId: 'org-A' }; next(); });
    app.use('/api/ingest', router);

    const res = await request(app)
      .post('/api/ingest')
      .attach('file', Buffer.from(TEXT), { filename: 'teaser.txt', contentType: 'text/plain' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(res.body.reason).toBe('quota');
    expect(res.body.error).not.toMatch(/deal information/i);
    // The extractor must have been asked to surface provider errors.
    expect(extractDealDataFromText).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ throwOnProviderError: true }));
  });

  it('POST /api/ingest/text → 503 AI_PROVIDER_UNAVAILABLE', async () => {
    const { default: router } = await import('../src/routes/ingest-text.js');
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'u1', organizationId: 'org-A' }; next(); });
    app.use('/api/ingest', router);

    const res = await request(app).post('/api/ingest/text').send({ text: TEXT });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(res.body.reason).toBe('quota');
  });
});

/**
 * Security test for POST /api/ingest (file upload).
 *
 * Bug fixed: `targetDealId` from the multipart form was passed to
 * mergeIntoExistingDeal() with no verification that the deal belongs to
 * the caller's org. This test asserts the verifyDealAccess gate now blocks
 * cross-org dealId references with a 404, and that mergeIntoExistingDeal
 * is NEVER reached for cross-org targets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the heavy services — we only want to exercise the org-gate path.
const mergeIntoExistingDeal = vi.fn();
vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal,
  getIconForIndustry: () => 'briefcase',
}));

// Stub AI extractor so we always get a valid extraction structure
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

vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/documentDedup.js', () => ({
  findExistingDocument: vi.fn(async () => null),
  logDuplicateSkip: vi.fn(),
}));
vi.mock('../src/services/firmTeaserService.js', () => ({
  generateTeasersForDeal: vi.fn(async () => {}),
}));

vi.mock('../src/services/documentParser.js', () => ({ extractTextFromWord: vi.fn() }));
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: vi.fn(),
  isExcelFile: () => false,
}));
vi.mock('../src/services/langExtractClient.js', () => ({
  deepExtract: vi.fn(),
  isDeepExtractionAvailable: () => false,
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: vi.fn() } }));
vi.mock('../src/services/financialValidator.js', () => ({
  validateFinancials: () => ({ isValid: true, warnings: [] }),
}));
vi.mock('../src/routes/notifications.js', () => ({
  resolveUserId: vi.fn(),
}));

// Stub PDF extractor so multer payload doesn't need real PDF bytes.
vi.mock('../src/routes/ingest-shared.js', async () => {
  const multer = (await import('multer')).default;
  return {
    extractTextFromPDF: async () => ({
      text: 'A'.repeat(500), // long enough to satisfy extractor minimum
      numPages: 1,
      source: 'pdf-parse',
      sparse: false,
    }),
    upload: multer({ storage: multer.memoryStorage() }),
  };
});

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async () => {
  const { default: router } = await import('../src/routes/ingest-upload.js');
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: 'org-A' };
    next();
  });
  app.use('/api/ingest', router);
  return app;
};

describe('POST /api/ingest (file) — cross-tenant protection (F-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 and does NOT call mergeIntoExistingDeal when targetDealId is from another org', async () => {
    verifyDealAccess.mockResolvedValue(null);

    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest')
      .field('dealId', 'deal-from-org-B')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf'), {
        filename: 'cim.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(404);
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-B', 'org-A');
    expect(mergeIntoExistingDeal).not.toHaveBeenCalled();
  });
});

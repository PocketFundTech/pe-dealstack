/**
 * Security test for POST /api/ingest/text.
 *
 * Bug fixed: `dealId` from the JSON body was passed to mergeIntoExistingDeal()
 * with no verification that the deal belonged to the caller's org. This test
 * asserts the verifyDealAccess gate now blocks cross-org dealId references
 * with a 404, and that mergeIntoExistingDeal is NEVER reached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mergeIntoExistingDeal = vi.fn();
vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal,
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

vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiIngest: vi.fn() } }));
vi.mock('../src/services/financialValidator.js', () => ({
  validateFinancials: () => ({ isValid: true, warnings: [] }),
}));
vi.mock('../src/routes/notifications.js', () => ({
  resolveUserId: vi.fn(),
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async () => {
  const { default: router } = await import('../src/routes/ingest-text.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: 'org-A' };
    next();
  });
  app.use('/api/ingest', router);
  return app;
};

describe('POST /api/ingest/text — cross-tenant protection (F-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 and does NOT call mergeIntoExistingDeal when dealId is from another org', async () => {
    verifyDealAccess.mockResolvedValue(null);

    const app = await buildApp();
    const res = await request(app)
      .post('/api/ingest/text')
      .send({
        text: 'Acme is a healthcare company with $50M revenue and $10M EBITDA. Founded in 2010, they serve 10,000 patients.',
        sourceType: 'email',
        dealId: '00000000-0000-0000-0000-00000000beef',
      });

    expect(res.status).toBe(404);
    expect(verifyDealAccess).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-00000000beef',
      'org-A',
    );
    expect(mergeIntoExistingDeal).not.toHaveBeenCalled();
  });
});

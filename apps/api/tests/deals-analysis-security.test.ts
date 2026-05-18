import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks BEFORE importing the router
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { log: vi.fn() },
}));
const analyzeMultipleDocuments = vi.fn();
vi.mock('../src/services/multiDocAnalyzer.js', () => ({ analyzeMultipleDocuments }));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/deals-analysis.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/deals', router);
  return app;
};

describe('POST /api/deals/:id/analyze — cross-tenant protection (F-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when deal belongs to another org', async () => {
    verifyDealAccess.mockResolvedValue(null);
    const app = await buildApp('org-A');

    const res = await request(app).post('/api/deals/deal-from-org-B/analyze').send({});

    expect(res.status).toBe(404);
    expect(verifyDealAccess).toHaveBeenCalledWith('deal-from-org-B', 'org-A');
    // Analyzer must NOT be invoked for cross-org deal
    expect(analyzeMultipleDocuments).not.toHaveBeenCalled();
  });

  it('runs analysis when deal belongs to caller org', async () => {
    verifyDealAccess.mockResolvedValue({ id: 'deal-A', organizationId: 'org-A', name: 'Project Apollo' });
    analyzeMultipleDocuments.mockResolvedValue({
      documentContributions: [{}, {}],
      conflicts: [],
      gapsFilled: [],
    });
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'deal-A', name: 'Project Apollo' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'Activity') {
        return { insert: async () => ({ data: null, error: null }) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).post('/api/deals/deal-A/analyze').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(analyzeMultipleDocuments).toHaveBeenCalledWith('deal-A');
  });
});

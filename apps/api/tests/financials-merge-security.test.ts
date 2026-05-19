import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/financials-merge.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api', router);
  return app;
};

describe('POST /api/deals/:dealId/financials/resolve — chosenVersionId binding (F-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('rejects when chosenVersionId is not in the versions list for (dealId, statementType, period)', async () => {
    verifyDealAccess.mockResolvedValue({ id: 'deal-A1', organizationId: 'org-A' });
    let activationUpdate: { id: string | null } = { id: null };

    const versions = [
      { id: '11111111-1111-1111-1111-111111111111', isActive: false },
      { id: '22222222-2222-2222-2222-222222222222', isActive: false },
    ];

    let updateCallCount = 0;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'FinancialStatement') {
        return {
          // Pre-fetch: chained .eq(dealId).eq(statementType).eq(period)
          select: () => {
            const chain: any = {
              eq: () => chain,
              then: (resolve: any) => resolve({ data: versions, error: null }),
            };
            return chain;
          },
          update: () => {
            updateCallCount++;
            return {
              in: () => Promise.resolve({ error: null }),
              eq: (col: string, val: string) => {
                if (col === 'id') activationUpdate.id = val;
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/deals/deal-A1/financials/resolve')
      .send({
        statementType: 'INCOME_STATEMENT',
        period: '2024-Q4',
        // foreign version id NOT in versions[]
        chosenVersionId: '00000000-0000-0000-0000-000000000099',
      });

    // Fix should refuse the cross-version activation
    expect(res.status).toBe(400);
    // The activation update with that foreign id must NOT have fired
    expect(activationUpdate.id).not.toBe('00000000-0000-0000-0000-000000000099');
  });

  it('proceeds when chosenVersionId is in the versions list', async () => {
    verifyDealAccess.mockResolvedValue({ id: 'deal-A1', organizationId: 'org-A' });
    let activationUpdate: { id: string | null } = { id: null };

    const versions = [
      { id: '11111111-1111-1111-1111-111111111111', isActive: false },
      { id: '22222222-2222-2222-2222-222222222222', isActive: false },
    ];

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'FinancialStatement') {
        return {
          select: () => {
            const chain: any = {
              eq: () => chain,
              then: (resolve: any) => resolve({ data: versions, error: null }),
            };
            return chain;
          },
          update: () => ({
            in: () => Promise.resolve({ error: null }),
            eq: (col: string, val: string) => {
              if (col === 'id') activationUpdate.id = val;
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/deals/deal-A1/financials/resolve')
      .send({
        statementType: 'INCOME_STATEMENT',
        period: '2024-Q4',
        chosenVersionId: '22222222-2222-2222-2222-222222222222',
      });

    expect(res.status).toBe(200);
    expect(activationUpdate.id).toBe('22222222-2222-2222-2222-222222222222');
  });
});

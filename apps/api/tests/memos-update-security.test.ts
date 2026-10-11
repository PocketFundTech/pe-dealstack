import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * PATCH /api/memos/:id accepted any `dealId` in the body (updateMemoSchema is
 * createMemoSchema.partial()). The F-18 check only ran on POST, so a user
 * could re-point their own memo at another org's deal; GET /memos/:id, section
 * generation and the memo agent then read that deal's financials/documents
 * through memo.dealId, and the memo surfaced on the other org's share portal.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => mock.from(t), rpc: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  generateAllSections: vi.fn(),
  COMPREHENSIVE_IC_SECTIONS: [],
  STANDARD_IC_SECTIONS: [],
  SEARCH_FUND_SECTIONS: [],
  SCREENING_NOTE_SECTIONS: [],
}));
vi.mock('../src/services/ai/client.js', () => ({ isAnthropicAvailable: () => false }));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { memoCreated: vi.fn(), memoDeleted: vi.fn() },
}));
vi.mock('../src/middleware/rbac.js', () => ({
  PERMISSIONS: { MEMO_DELETE: 'memo.delete' },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user.organizationId,
}));

const DEAL_A = '11111111-1111-4111-8111-111111111111';
const DEAL_B = '22222222-2222-4222-8222-222222222222';
const dealOrg: Record<string, string> = { [DEAL_A]: 'org-A', [DEAL_B]: 'org-B' };

async function buildApp() {
  const { default: router } = await import('../src/routes/memos-mutate.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A' };
    next();
  });
  app.use('/api/memos', router);
  return app;
}

beforeEach(() => {
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    if (op.table === 'Deal') {
      const id = filterValue(op, 'id') as string;
      const org = filterValue(op, 'organizationId');
      return dealOrg[id] && dealOrg[id] === org ? { data: { id } } : { data: null, error: { code: 'PGRST116' } };
    }
    if (op.table === 'Memo') return { data: { id: 'memo-a', ...(op.payload as object) } };
    return {};
  };
});

describe('PATCH /api/memos/:id — dealId must stay inside the caller org', () => {
  it('rejects re-pointing a memo at another org\'s deal and writes nothing', async () => {
    const res = await request(await buildApp()).patch('/api/memos/memo-a').send({ dealId: DEAL_B });
    expect(res.status).toBe(400);
    expect(mock.calls.some((c) => c.table === 'Memo' && c.action === 'update')).toBe(false);
  });

  it('allows moving a memo to a deal in the caller org', async () => {
    const res = await request(await buildApp()).patch('/api/memos/memo-a').send({ dealId: DEAL_A });
    expect(res.status).toBe(200);
    const upd = mock.calls.find((c) => c.table === 'Memo' && c.action === 'update');
    expect(upd && filterValue(upd, 'organizationId')).toBe('org-A');
  });

  it('still allows updates that do not touch dealId', async () => {
    const res = await request(await buildApp()).patch('/api/memos/memo-a').send({ title: 'New title' });
    expect(res.status).toBe(200);
    expect(mock.calls.some((c) => c.table === 'Deal')).toBe(false);
  });
});

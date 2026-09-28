/**
 * GET /api/internal/usage/reconciliation — reads the stored daily
 * Anthropic drift rows written by the usage-reconciliation cron.
 * Route is already guarded by requireInternalAdmin (mocked here as a
 * pass-through so this test focuses on the query/response shape).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/middleware/internalAdmin.js', () => ({
  requireInternalAdmin: (_req: any, _res: any, next: any) => next(),
}));

let rows: any[] = [];
let queryError: { code?: string; message: string } | null = null;

function tableMock() {
  return (table: string) => {
    if (table === 'UsageReconciliation') {
      const chain: any = {
        select: () => chain,
        gte: () => chain,
        order: () => ({ data: queryError ? null : rows, error: queryError }),
      };
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/internal-usage.js');
  const app = express();
  app.use(express.json());
  app.use('/api/internal', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  rows = [];
  queryError = null;
  mockSupabase.from.mockImplementation(tableMock());
});

describe('GET /api/internal/usage/reconciliation', () => {
  it('returns stored rows newest first', async () => {
    rows = [
      { day: '2026-09-28', driftUsd: 0.1 },
      { day: '2026-09-27', driftUsd: 0.05 },
    ];
    const app = await buildApp();
    const res = await request(app).get('/api/internal/usage/reconciliation?days=30');

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual(rows);
  });

  it('degrades to an empty list when the table does not exist yet', async () => {
    queryError = { code: 'PGRST205', message: 'table not found' };
    const app = await buildApp();
    const res = await request(app).get('/api/internal/usage/reconciliation');

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('returns 500 for a real query error', async () => {
    queryError = { message: 'connection reset' };
    const app = await buildApp();
    const res = await request(app).get('/api/internal/usage/reconciliation');

    expect(res.status).toBe(500);
  });
});

/**
 * /api/api-keys route: the scope field on create/list, and graceful
 * degradation when api-key-scope-migration.sql hasn't been run yet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const MISSING_COLUMN = { code: '42703', message: 'column ApiKey.scope does not exist' };

const { state } = vi.hoisted(() => ({
  state: {
    // First queued result answers the first query this test makes; the
    // second (if present) answers the fallback query after a missing-column
    // error. Shifted off on each call so sequential calls see different results.
    listResults: [] as { data: unknown[] | null; error: { code?: string; message?: string } | null }[],
    insertResults: [] as { data: Record<string, unknown> | null; error: { code?: string; message?: string } | null }[],
    insertedRows: [] as Record<string, unknown>[],
  },
}));

vi.mock('../src/supabase.js', () => {
  const chain: Record<string, any> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.is = () => chain;
  chain.order = async () => state.listResults.shift() ?? { data: [], error: null };
  chain.insert = (row: Record<string, unknown>) => {
    state.insertedRows.push(row);
    return { select: () => ({ single: async () => state.insertResults.shift() ?? { data: null, error: null } }) };
  };
  chain.update = () => chain;
  chain.maybeSingle = async () => ({ data: { id: 'key-1' }, error: null });
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'User') return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'user-row-1' } }) }) }) };
        return chain;
      },
    },
  };
});
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));

import router from '../src/routes/api-keys.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: 'auth-1', role: 'ADMIN' }; next(); });
  a.use('/api/api-keys', router);
  return a;
}

beforeEach(() => {
  state.listResults = [];
  state.insertResults = [];
  state.insertedRows = [];
});

describe('POST /api/api-keys scope', () => {
  it('defaults to full access when scope is omitted', async () => {
    state.insertResults = [{ data: { id: 'k1', name: 'x', scope: 'full' }, error: null }];
    await request(app()).post('/api/api-keys').send({ name: 'n8n' });
    expect(state.insertedRows[0]).toMatchObject({ scope: 'full' });
    expect(state.insertedRows).toHaveLength(1); // no fallback attempt needed
  });

  it('accepts an explicit read_only scope', async () => {
    state.insertResults = [{ data: { id: 'k1', name: 'x', scope: 'read_only' }, error: null }];
    const res = await request(app()).post('/api/api-keys').send({ name: 'reporting tool', scope: 'read_only' });
    expect(res.status).toBe(201);
    expect(state.insertedRows[0]).toMatchObject({ scope: 'read_only' });
    expect(res.body.apiKey.scope).toBe('read_only');
  });

  it('rejects an invalid scope value', async () => {
    const res = await request(app()).post('/api/api-keys').send({ name: 'x', scope: 'super-admin' });
    expect(res.status).toBe(400);
    expect(state.insertedRows).toHaveLength(0);
  });

  it('falls back to a scope-less insert when the column is missing, for a full key', async () => {
    state.insertResults = [
      { data: null, error: MISSING_COLUMN },
      { data: { id: 'k1', name: 'n8n' }, error: null },
    ];
    const res = await request(app()).post('/api/api-keys').send({ name: 'n8n' });
    expect(res.status).toBe(201);
    expect(res.body.apiKey.scope).toBe('full');
    expect(state.insertedRows).toHaveLength(2);
    expect(state.insertedRows[0]).toHaveProperty('scope', 'full');
    expect(state.insertedRows[1]).not.toHaveProperty('scope');
  });

  it('refuses a read_only key with 503 when the column is missing, rather than silently granting full access', async () => {
    state.insertResults = [{ data: null, error: MISSING_COLUMN }];
    const res = await request(app()).post('/api/api-keys').send({ name: 'n8n', scope: 'read_only' });
    expect(res.status).toBe(503);
    // only the first (failed) insert attempt ran — no fallback insert for read_only
    expect(state.insertedRows).toHaveLength(1);
  });
});

describe('GET /api/api-keys scope', () => {
  it('includes scope in listed keys', async () => {
    state.listResults = [{ data: [{ id: 'k1', name: 'x', scope: 'read_only' }], error: null }];
    const res = await request(app()).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.apiKeys[0].scope).toBe('read_only');
  });

  it('falls back and reports full access for every key when the column is missing', async () => {
    state.listResults = [
      { data: null, error: MISSING_COLUMN },
      { data: [{ id: 'k1', name: 'x' }, { id: 'k2', name: 'y' }], error: null },
    ];
    const res = await request(app()).get('/api/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.apiKeys).toHaveLength(2);
    expect(res.body.apiKeys.every((k: { scope: string }) => k.scope === 'full')).toBe(true);
  });
});

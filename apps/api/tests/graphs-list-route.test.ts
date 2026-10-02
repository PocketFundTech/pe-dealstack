/**
 * GET /api/graphs — cross-deal list. Deal labels come from a second query,
 * not a PostgREST embed (the embed 500'd in production when the
 * CustomGraph.dealId → Deal FK was absent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { state } = vi.hoisted(() => ({
  state: {
    graphs: { data: [] as unknown[] | null, error: null as unknown },
    deals: { data: [] as unknown[], error: null as unknown },
    calls: [] as { table: string; method: string; args: unknown[] }[],
  },
}));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const m of ['select', 'eq', 'in', 'order']) {
        chain[m] = (...args: unknown[]) => { state.calls.push({ table, method: m, args }); return chain; };
      }
      chain.then = (resolve: (v: unknown) => unknown) => resolve(table === 'CustomGraph' ? state.graphs : state.deals);
      return chain;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A', verifyDealAccess: vi.fn() }));

import router from '../src/routes/graphs.js';

const app = express().use(express.json()).use('/api', router);

beforeEach(() => {
  state.graphs = { data: [], error: null };
  state.deals = { data: [], error: null };
  state.calls = [];
});

describe('GET /api/graphs', () => {
  it('attaches deal name and company as projectName/target without an embed', async () => {
    state.graphs.data = [
      { id: 'g1', dealId: 'd1', title: 'Revenue' },
      { id: 'g2', dealId: 'd1', title: 'EBITDA' },
      { id: 'g3', dealId: 'd-gone', title: 'Orphan' },
    ];
    state.deals.data = [{ id: 'd1', name: 'Project Falcon', company: { name: 'Falcon Logistics' } }];

    const res = await request(app).get('/api/graphs');

    expect(res.status).toBe(200);
    expect(res.body[0].deal).toEqual({ id: 'd1', projectName: 'Project Falcon', target: 'Falcon Logistics' });
    expect(res.body[2].deal).toBeNull();
    const graphSelect = state.calls.find((c) => c.table === 'CustomGraph' && c.method === 'select');
    expect(graphSelect?.args[0]).toBe('*');
    expect(state.calls).toContainEqual({ table: 'Deal', method: 'in', args: ['id', ['d1', 'd-gone']] });
    expect(state.calls).toContainEqual({ table: 'Deal', method: 'eq', args: ['organizationId', 'org-A'] });
  });

  it('skips the deal lookup when there are no graphs', async () => {
    const res = await request(app).get('/api/graphs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(state.calls.some((c) => c.table === 'Deal')).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1', verifyDealAccess: (...a: unknown[]) => verifyDealAccess(...a) }));

import router from '../src/routes/deals-contacts.js';

const app = express();
app.use('/api/deals', router);

beforeEach(() => { chain.calls.length = 0; verifyDealAccess.mockReset(); });

describe('GET /api/deals/:dealId/contacts', () => {
  it('404s for a deal outside the org', async () => {
    verifyDealAccess.mockResolvedValue(false);
    const res = await request(app).get('/api/deals/d-x/contacts');
    expect(res.status).toBe(404);
    expect(chain.calls.some((c) => c.table === 'ContactDeal')).toBe(false);
  });

  it('returns linked contacts with their role', async () => {
    verifyDealAccess.mockResolvedValue(true);
    resolver = (op) => (op.table === 'ContactDeal' ? { data: [
      { role: 'BANKER', contact: { id: 'c1', firstName: 'Ann', lastName: 'Lee', email: 'a@x.com', title: 'MD', company: 'Bank' } },
      { role: 'OTHER', contact: null },
    ] } : undefined);
    const res = await request(app).get('/api/deals/d1/contacts');
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([
      { id: 'c1', firstName: 'Ann', lastName: 'Lee', email: 'a@x.com', title: 'MD', company: 'Bank', role: 'BANKER' },
    ]);
    expect(filterValue(chain.calls[0], 'dealId')).toBe('d1');
  });
});

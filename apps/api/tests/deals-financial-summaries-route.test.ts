/**
 * GET /api/deals/financial-summaries — the headline revenue / EBITDA shown on
 * deal cards. A cumulative "Total" column (Jan 2023 – Jun 2026) was chosen as
 * the latest period and put a 42-month total on the card (CSP, 14 Oct 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));

let deals: any[] = [];
let statements: any[] = [];

function chainFor(rows: any[]) {
  const chain: any = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: any) => resolve({ data: rows, error: null });
  return chain;
}

beforeEach(() => {
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'Deal') return chainFor(deals);
    if (table === 'FinancialStatement') return chainFor(statements);
    throw new Error(`unexpected table ${table}`);
  });
});

async function app() {
  const router = (await import('../src/routes/deals-financial-summaries.js')).default;
  const a = express();
  a.use(express.json());
  a.use('/api/deals', router);
  return a;
}

const row = (period: string, revenue: number, ebitda: number) => ({
  dealId: 'deal-1', period, periodType: 'HISTORICAL', unitScale: 'MILLIONS', currency: 'USD',
  lineItems: { revenue, ebitda },
});

describe('GET /api/deals/financial-summaries', () => {
  it('shows the latest real fiscal year, never a multi-year "Total" column', async () => {
    deals = [{ id: 'deal-1' }];
    statements = [
      row('2024', 3.249, 0.793),
      row('2025', 12.468, 3.647),
      row('Jan 2023 - Jun 2026 (Total)', 21.418, 4.473),
    ];
    const res = await request(await app()).get('/api/deals/financial-summaries?dealIds=deal-1');
    expect(res.status).toBe(200);
    expect(res.body.summaries['deal-1']).toMatchObject({ latestPeriod: '2025', revenue: 12.468, ebitda: 3.647 });
  });
});

describe('GET /api/deals/financial-summaries — Adjusted EBITDA (15 Oct)', () => {
  it('reports adjusted EBITDA and its margin when present', async () => {
    deals = [{ id: 'deal-1' }];
    statements = [{ ...row('2025', 12.468, 2.497), lineItems: { revenue: 12.468, ebitda: 2.497, adjusted_ebitda: 3.647 } }];
    const res = await request(await app()).get('/api/deals/financial-summaries?dealIds=deal-1');
    expect(res.body.summaries['deal-1'].ebitda).toBe(3.647);
    expect(res.body.summaries['deal-1'].ebitdaMargin).toBeCloseTo(29.3, 1);
  });
});

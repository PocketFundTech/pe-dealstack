// AI cost plan A1/A3: deal chat sends a short financial summary on every
// message and fetches line items through get_deal_financials only when a
// question needs them; read-only tool results are capped.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let statementRows: any[] = [];
const statementFilters: Array<[string, string]> = [];

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => {
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => {
          statementFilters.push([col, val]);
          return chain;
        },
        then: (resolve: any) => {
          const typeFilter = statementFilters.find(([c]) => c === 'statementType');
          const data = typeFilter ? statementRows.filter((r) => r.statementType === typeFilter[1]) : statementRows;
          return resolve({ data, error: null });
        },
      };
      return chain;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildFinancialSummary } from '../src/services/agents/dealChatAgent/financialContext.js';
import { makeGetDealFinancialsTool } from '../src/services/agents/dealChatAgent/tools/getDealFinancials.js';
import { capToolResult } from '../src/services/agents/dealChatAgent/tools.js';

const income = (period: string, revenue: number, ebitda: number, extra: Record<string, number> = {}) => ({
  statementType: 'INCOME_STATEMENT',
  period,
  lineItems: { revenue, cogs: -revenue / 2, total_opex: -(revenue / 2 - ebitda), ebitda, ...extra },
  unitScale: 'MILLIONS',
  currency: 'USD',
});

const DEAL_ROWS = [
  income('FY2020', 10, 1),
  income('FY2021', 12.5, 2),
  income('FY2022', 16.8, 3),
  income('FY2023', 21, 4, { sga: -5.5 }),
  income('FY2024', 27.3, 5.5),
  income('Q1 2025', 7.9, 1.6),
  { statementType: 'BALANCE_SHEET', period: 'FY2024', lineItems: { cash: 3.2, long_term_debt: 8 }, unitScale: 'MILLIONS', currency: 'USD' },
];

beforeEach(() => {
  statementRows = DEAL_ROWS;
  statementFilters.length = 0;
});

describe('buildFinancialSummary', () => {
  const summary = buildFinancialSummary(DEAL_ROWS);

  it('shows the latest three fiscal years with revenue, growth, EBITDA and margin', () => {
    expect(summary).toContain('- FY2022: revenue $16.8M, EBITDA $3.0M, margin 17.9%');
    expect(summary).toContain('- FY2023: revenue $21.0M, growth 25.0%, EBITDA $4.0M, margin 19.0%');
    expect(summary).toContain('- FY2024: revenue $27.3M, growth 30.0%, EBITDA $5.5M, margin 20.1%');
    expect(summary).not.toContain('FY2021:');
    expect(summary).not.toContain('Q1 2025:');
  });

  it('lists what else is on file and tells the model how to fetch it', () => {
    expect(summary).toContain('- Income Statement: 6 periods (FY2020 to Q1 2025)');
    expect(summary).toContain('- Balance Sheet: 1 period (FY2024)');
    expect(summary).toContain('call get_deal_financials with statementType and/or periods');
  });

  it('leaves line items out — that is the whole saving', () => {
    expect(summary).not.toContain('cogs');
    expect(summary).not.toContain('sga');
    expect(summary).not.toContain('long_term_debt');
    // Far smaller than the full tables it replaces, and bounded by 3 years
    // however many periods a deal has.
    expect(summary.length).toBeLessThan(1200);
  });

  it('falls back to the latest periods when there are no full fiscal years', () => {
    const monthly = buildFinancialSummary([income('Jan 2025', 1, 0.1), income('Feb 2025', 1.1, 0.2)]);
    expect(monthly).toContain('latest periods');
    expect(monthly).toContain('- Feb 2025: revenue $1.1M, growth 10.0%');
  });

  it('says so when nothing is extracted', () => {
    expect(buildFinancialSummary([])).toContain('No extracted financial data available yet');
  });
});

describe('get_deal_financials line-item mode', () => {
  const tool = makeGetDealFinancialsTool('deal-1', 'org-1');

  it('returns the full line items for the requested periods', async () => {
    const out = await tool.run(tool.parse({ periods: ['FY23'] }));
    expect(out).toContain('| sga | -5.5 |');
    expect(out).toContain('FY2023');
    expect(out).not.toContain('FY2022');
  });

  it('filters by statement type', async () => {
    const out = await tool.run(tool.parse({ statementType: 'BALANCE_SHEET' }));
    expect(statementFilters).toContainEqual(['statementType', 'BALANCE_SHEET']);
    expect(out).toContain('| long_term_debt | 8 |');
    expect(out).not.toContain('cogs');
  });

  it('caps an open request to the latest periods and says how to see others', async () => {
    statementRows = Array.from({ length: 12 }, (_, i) => income(`FY${2010 + i}`, 10 + i, 1));
    const out = await tool.run(tool.parse({ statementType: 'INCOME_STATEMENT' }));
    expect(out).toContain('FY2021');
    expect(out).not.toContain('FY2013');
    expect(out).toContain('showing the latest 8 of 12 periods');
  });

  it('names the periods on file when none match', async () => {
    const out = await tool.run(tool.parse({ periods: ['FY1999'] }));
    expect(out).toMatch(/^No statements for FY1999\. Periods on file: FY2020/);
  });

  it('still accepts the old no-argument call', () => {
    expect(tool.parse(undefined)).toEqual({});
    expect(tool.parse({})).toEqual({});
  });
});

describe('capToolResult', () => {
  const big = 'x'.repeat(20_000);

  it('truncates a long read-only result and says so', async () => {
    const tool = capToolResult({ name: 'search_documents', run: async () => big });
    const out = await tool.run();
    expect(out.length).toBeLessThan(16_200);
    expect(out).toContain('[Result truncated: 4000 more characters');
  });

  it('leaves short results and side-effect tools alone', async () => {
    expect(await capToolResult({ name: 'search_documents', run: async () => 'short' }).run()).toBe('short');
    expect(await capToolResult({ name: 'generate_chart', run: async () => big }).run()).toBe(big);
  });
});

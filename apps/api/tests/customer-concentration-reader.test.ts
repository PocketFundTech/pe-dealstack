/**
 * Fix plan F1 (part 2): the document read behind the concentration flags.
 * ai/client, supabase and the cache table are mocked — no live AI calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let nextText = '';
let aiFails = false;
let aiDelayMs = 0;
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    if (aiDelayMs) await new Promise((r) => setTimeout(r, aiDelayMs));
    if (aiFails) throw new Error('credit balance too low');
    return { text: nextText, model: 'claude-haiku-4-5', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
  }),
  isAnthropicAvailable: () => true,
}));

// Document rows for the deal; the listing query and the text query both read these.
let docs: Array<{ id: string; name: string; type: string; updatedAt: string; extractedText: string | null }> = [];
const selects: string[] = [];
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (_table: string) => {
      let cols = '';
      const chain: any = {
        select: (c: string) => { cols = c; selects.push(c); return chain; },
        eq: () => chain,
        not: () => chain,
        then: (resolve: any) => resolve({
          data: docs.filter((d) => d.extractedText != null).map((d) =>
            Object.fromEntries(cols.split(',').map((k) => k.trim()).map((k) => [k, (d as any)[k]]))),
          error: null,
        }),
      };
      return chain;
    },
  },
}));

const cache = new Map<string, unknown>();
const puts: any[] = [];
vi.mock('../src/services/agents/financialAgent/extractionCache.js', async (orig) => ({
  ...(await orig<any>()),
  getCachedExtraction: async (key: any) => cache.get(`${key.contentHash}|${key.extractionMode}|${key.modelTier}`) ?? null,
  putCachedExtraction: async (key: any, result: unknown) => {
    puts.push({ key, result });
    cache.set(`${key.contentHash}|${key.extractionMode}|${key.modelTier}`, result);
    return true;
  },
}));
const background: string[] = [];
vi.mock('../src/utils/background.js', () => ({
  runInBackground: (label: string, p: Promise<unknown>) => { background.push(label); void p; },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  getConcentrationFacts, buildExcerpts, extractConcentrationFacts, locateQuote, toFacts,
  CONCENTRATION_JSON_SCHEMA, MAX_TOTAL_CHARS,
} from '../src/services/analysis/customerConcentrationReader.js';
import { computeConcentrationRedFlags } from '../src/services/analysis/customerConcentrationFlags.js';

const SRM_CIM = [
  'Strong Ready Mix supplies ready-mix concrete across the region. '.repeat(40),
  'Customer concentration: Apex Builders, a part-owner of the company, represented 39% of FY2024 revenue.',
  'The plant is leased from Hill Holdings LLC, an entity owned by the founder.',
  'Filler text about trucks and batching plants. '.repeat(60),
].join('\n');

const SRM_ANSWER = {
  customers: [{
    name: 'Apex Builders', revenueSharePct: 39, relatedParty: true, relationship: 'part-owner of the company',
    quote: 'Apex Builders, a part-owner of the company, represented 39% of FY2024 revenue.', document: 'SRM CIM.pdf',
  }],
  topCustomers: null,
  relatedPartyTransactions: [{
    counterparty: 'Hill Holdings LLC', relationship: 'owned by the founder', nature: 'leases the plant',
    quote: 'The plant is leased from Hill Holdings LLC, an entity owned by the founder.', document: 'SRM CIM.pdf',
  }],
};

beforeEach(() => {
  calls.length = 0; selects.length = 0; puts.length = 0; background.length = 0;
  cache.clear();
  aiFails = false; aiDelayMs = 0;
  nextText = JSON.stringify(SRM_ANSWER);
  docs = [{ id: 'd1', name: 'SRM CIM.pdf', type: 'CIM', updatedAt: '2026-09-30T10:00:00Z', extractedText: SRM_CIM }];
});

describe('extraction call shape', () => {
  it('one structured call: operation, fast role, schema, cached system prompt with today\'s date, wrapped excerpts', async () => {
    await extractConcentrationFacts(buildExcerpts([{ name: 'SRM CIM.pdf', type: 'CIM', text: SRM_CIM }]));
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.operation).toBe('customer_concentration');
    expect(c.role).toBe('fast');
    expect(c.outputSchema).toBe(CONCENTRATION_JSON_SCHEMA);
    expect(c.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(c.system[0].text).toContain(`Today's date is ${new Date().toISOString().slice(0, 10)}`);
    const docBlock = c.messages[0].content[0].text;
    expect(docBlock).toContain('<document name="SRM CIM.pdf">');
    expect(docBlock).toContain('represented 39% of FY2024 revenue');
  });

  it('no excerpts → no call, empty facts', async () => {
    const f = await extractConcentrationFacts([]);
    expect(calls).toHaveLength(0);
    expect(computeConcentrationRedFlags(f)).toEqual([]);
  });
});

describe('excerpts', () => {
  it('sends keyword windows only, CIM first, within the total budget', () => {
    const ex = buildExcerpts([
      { name: 'Other.docx', type: 'OTHER', text: 'Our customers love us. ' + 'x'.repeat(5000) },
      { name: 'SRM CIM.pdf', type: 'CIM', text: SRM_CIM },
      { name: 'Model.xlsx', type: 'FINANCIALS', text: 'Revenue 27.3 EBITDA 2.2' },
    ]);
    expect(ex.map((e) => e.document)).toEqual(['SRM CIM.pdf', 'Other.docx']);
    expect(ex[0].text).toContain('part-owner of the company, represented 39%');
    expect(ex[0].text.length).toBeLessThan(SRM_CIM.length);
    const huge = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, type: 'CIM', text: 'related party sale. '.repeat(5000) }));
    expect(buildExcerpts(huge).reduce((s, e) => s + e.text.length, 0)).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
  });
});

describe('quote verification (never invent)', () => {
  const ex = [{ document: 'SRM CIM.pdf', text: SRM_CIM }];
  it('finds a verbatim quote (whitespace / quote marks tolerant) and fixes the document name', () => {
    expect(locateQuote('Apex  Builders, a part-owner of the company,\nrepresented 39% of FY2024 revenue.', 'wrong.pdf', ex)).toBe('SRM CIM.pdf');
  });
  it('drops items whose quote is not in the text', () => {
    const f = toFacts({ ...SRM_ANSWER, customers: [{ ...SRM_ANSWER.customers[0], quote: 'Apex Builders is 45% of revenue.' }] }, ex);
    expect(f.customers).toEqual([]);
    expect(f.relatedPartyTransactions).toHaveLength(1);
  });
  it('drops out-of-range shares and customers with neither a share nor a relationship', () => {
    const f = toFacts({ customers: [{ ...SRM_ANSWER.customers[0], revenueSharePct: 390, relatedParty: false }], topCustomers: null, relatedPartyTransactions: [] }, ex);
    expect(f.customers).toEqual([]);
  });
});

describe('getConcentrationFacts caching', () => {
  it('SRM end to end: first view reads + caches; second view hits the cache with no AI call', async () => {
    const first = await getConcentrationFacts('srm', { generate: true });
    expect(calls).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(puts[0].key.extractionMode).toBe('customer_concentration');
    const flags = computeConcentrationRedFlags(first);
    expect(flags.map((f) => [f.id, f.severity])).toEqual([
      ['customer_concentration', 'critical'],
      ['related_party_customer', 'critical'],
      ['related_party_transactions', 'warning'],
    ]);

    const second = await getConcentrationFacts('srm', { generate: true });
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    // The cache lookup lists documents without loading their text.
    expect(selects.at(-1)).toBe('id, name, type, updatedAt');
  });

  it('a new or updated document busts the cache', async () => {
    await getConcentrationFacts('srm', { generate: true });
    docs[0].updatedAt = '2026-10-01T09:00:00Z';
    await getConcentrationFacts('srm', { generate: true });
    expect(calls).toHaveLength(2);
  });

  it('cache-only mode never calls the model', async () => {
    expect(await getConcentrationFacts('srm')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('no documents with text → null, no call', async () => {
    docs = [{ id: 'd1', name: 'scan.pdf', type: 'CIM', updatedAt: 'x', extractedText: null }];
    expect(await getConcentrationFacts('srm', { generate: true })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('documents without any concentration language → empty facts cached without a call', async () => {
    docs[0].extractedText = 'Revenue 27.3 EBITDA 2.2';
    const f = await getConcentrationFacts('srm', { generate: true });
    expect(calls).toHaveLength(0);
    expect(f?.customers).toEqual([]);
    expect(puts).toHaveLength(1);
  });

  it('AI failure → null and nothing cached (next view retries)', async () => {
    aiFails = true;
    expect(await getConcentrationFacts('srm', { generate: true })).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it('slow read: the view returns without it and the read finishes in the background', async () => {
    aiDelayMs = 50;
    expect(await getConcentrationFacts('srm', { generate: true, waitMs: 5 })).toBeNull();
    expect(background).toEqual(['customer-concentration']);
    await new Promise((r) => setTimeout(r, 80));
    expect(puts).toHaveLength(1);
    expect(await getConcentrationFacts('srm')).not.toBeNull();
  });
});

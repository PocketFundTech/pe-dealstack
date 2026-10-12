/**
 * memoAgent/pipeline.ts — deal-context cache warm-up (AI cost plan item C).
 *
 * A batch starts its sections in parallel, so before this every section in
 * batch 1 missed the cache and wrote the same deal-context entry (ledger:
 * 43 section calls, only ~15K cache-read tokens). The pipeline now sends one
 * `max_tokens: 0` warm-up on the exact shared prefix before batch 1.
 *
 * The SDK is mocked with a tiny prompt-cache simulator: a request reads the
 * entry only if an earlier request with the byte-identical prefix (model,
 * system, output_config, tools, content up to the breakpoint) has FINISHED —
 * which is what makes parallel calls miss in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoContext } from '../src/services/agents/memoAgent/context.js';

const PREFIX_TOKENS = 5000;
const sdkCalls: Array<{ kind: 'create' | 'stream'; req: any }> = [];
const cacheEntries = new Set<string>();
let createError: Error | null = null;

/** Everything that renders before (and including) the cache breakpoint. */
function prefixKey(req: any): string | null {
  const content = req.messages?.[0]?.content;
  if (!Array.isArray(content)) return null;
  const bp = content.findIndex((b: any) => b.cache_control);
  if (bp < 0) return null;
  return JSON.stringify({
    model: req.model,
    system: req.system,
    tools: req.tools,
    output_config: req.output_config,
    prefix: content.slice(0, bp + 1),
  });
}

function usageFor(key: string | null, hit: boolean) {
  return {
    input_tokens: key ? 300 : 6000,
    output_tokens: 0,
    cache_read_input_tokens: key && hit ? PREFIX_TOKENS : 0,
    cache_creation: { ephemeral_5m_input_tokens: key && !hit ? PREFIX_TOKENS : 0, ephemeral_1h_input_tokens: 0 },
  };
}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        create: async (req: any) => {
          sdkCalls.push({ kind: 'create', req });
          if (createError) throw createError;
          const key = prefixKey(req);
          const hit = key !== null && cacheEntries.has(key);
          if (key) cacheEntries.add(key);
          return { model: req.model, stop_reason: 'max_tokens', content: [], usage: usageFor(key, hit) };
        },
        stream: (req: any) => {
          sdkCalls.push({ kind: 'stream', req });
          const key = prefixKey(req);
          // Checked when the request starts; written when it finishes.
          const hit = key !== null && cacheEntries.has(key);
          const isCritique = !!req.output_config?.format;
          return {
            finalMessage: async () => {
              await new Promise((r) => setTimeout(r, 5));
              if (key) cacheEntries.add(key);
              const text = isCritique
                ? JSON.stringify({ overallPass: true, dimensions: [{ name: 'thesis_clarity', score: 4, pass: true }], sectionsNeedingRevision: [] })
                : '<h3>x</h3><p>ok</p>';
              return {
                model: req.model,
                stop_reason: 'end_turn',
                stop_details: null,
                content: [{ type: 'text', text }],
                usage: { ...usageFor(key, hit), output_tokens: 100 },
              };
            },
            currentMessage: undefined,
          };
        },
      },
    };
  }
  return { default: MockAnthropic };
});

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => { recorded.push(e); }),
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const buildMemoContext = vi.fn();
vi.mock('../src/services/agents/memoAgent/context.js', async () => {
  const actual = await vi.importActual('../src/services/agents/memoAgent/context.js');
  return { ...actual, buildMemoContext: (...args: any[]) => buildMemoContext(...args) };
});

function fakeContext(overrides: Partial<MemoContext> = {}): MemoContext {
  return {
    deal: { id: 'deal-1', name: 'Test Deal', stage: 'DUE_DILIGENCE', status: null, industry: 'Software', revenue: 10, ebitda: 2, dealSize: 50, irrProjected: null, mom: null, aiThesis: null, description: null, source: null },
    company: null,
    financials: [{ statementType: 'INCOME_STATEMENT', period: 'FY2023', lineItems: { Revenue: 10, EBITDA: 2 }, extractionConfidence: 90, extractionSource: 'ai', isActive: true }],
    documents: [],
    activity: [],
    team: { leadPartner: null, analyst: null, members: [] },
    dataAvailability: { hasFinancials: true, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
    ...overrides,
  };
}

// Two batches (BATCH_SIZE=3) — enough to show batch 1 reads too, with only
// one 2s inter-batch pause. Mixes prose and JSON-envelope sections.
const FOUR_SECTIONS = ['EXECUTIVE_SUMMARY', 'FINANCIAL_PERFORMANCE', 'MARKET_DYNAMICS', 'RISK_ASSESSMENT'] as const;

async function runMemo(types: readonly string[]) {
  const { generateAllSectionsStreaming } = await import('../src/services/agents/memoAgent/pipeline.js');
  const events: any[] = [];
  for await (const e of generateAllSectionsStreaming('deal-1', 'org-1', [...types] as any)) events.push(e);
  return events;
}

const sectionCalls = () => sdkCalls.filter((c) => c.kind === 'stream' && !c.req.output_config?.format);
const sectionRows = () => recorded.filter((r) => r.operation === 'memo_section_generation');

beforeEach(() => {
  sdkCalls.length = 0;
  recorded.length = 0;
  cacheEntries.clear();
  createError = null;
  buildMemoContext.mockReset();
  buildMemoContext.mockResolvedValue(fakeContext());
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.AI_MEMO_MODEL;
  delete process.env.AI_MEMO_EFFORT;
});

describe('memo deal-context cache warm-up', () => {
  it('warms once, non-streaming with max_tokens 0, before the first section call', async () => {
    await runMemo(FOUR_SECTIONS);

    const creates = sdkCalls.filter((c) => c.kind === 'create');
    expect(creates).toHaveLength(1);
    expect(sdkCalls[0].kind).toBe('create');

    const warm = creates[0].req;
    expect(warm.max_tokens).toBe(0);
    expect(warm.stream).toBeUndefined();
    expect(warm.output_config?.format).toBeUndefined();
    // Breakpoint on the shared context block, not on the placeholder after it.
    expect(warm.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(warm.messages[0].content[1].cache_control).toBeUndefined();
  }, 15_000);

  it('every section sends the byte-identical prefix the warm-up wrote', async () => {
    await runMemo(FOUR_SECTIONS);

    const warmKey = prefixKey(sdkCalls[0].req);
    expect(warmKey).not.toBeNull();
    const sections = sectionCalls();
    expect(sections).toHaveLength(4);
    for (const { req } of sections) {
      expect(prefixKey(req)).toBe(warmKey);
      // Section-specific text lives after the breakpoint only.
      expect(req.messages[0].content[0].text).not.toContain('Executive Summary');
    }
    // Same effort on warm-up and sections (effort changes invalidate the cache).
    expect(sections[0].req.output_config).toEqual(sdkCalls[0].req.output_config);
  }, 15_000);

  it('records the warm-up as memo_cache_warm and every section reads the cache — none write', async () => {
    await runMemo(FOUR_SECTIONS);

    const warmRows = recorded.filter((r) => r.operation === 'memo_cache_warm');
    expect(warmRows).toHaveLength(1);
    expect(warmRows[0]).toMatchObject({ status: 'success', provider: 'anthropic', completionTokens: 0, cacheWrite5mTokens: PREFIX_TOKENS });

    const rows = sectionRows();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.cacheReadTokens).toBe(PREFIX_TOKENS);
      expect(r.cacheWrite5mTokens).toBe(0);
    }
  }, 15_000);

  it('still generates every section when the warm-up fails', async () => {
    createError = new Error('529 overloaded');
    const events = await runMemo(FOUR_SECTIONS);

    const done = events.find((e) => e.type === 'done');
    expect(done.sections.filter((s: any) => s.aiGenerated)).toHaveLength(4);
    expect(recorded.filter((r) => r.operation === 'memo_cache_warm')).toEqual([
      expect.objectContaining({ status: 'error', promptTokens: 0, completionTokens: 0 }),
    ]);
  }, 15_000);

  it('skips the warm-up when fewer than two batch-1 sections call the model', async () => {
    // No financials: FINANCIAL_PERFORMANCE / QUALITY_OF_EARNINGS return a
    // placeholder without a call, leaving one real call in batch 1.
    buildMemoContext.mockResolvedValue(fakeContext({
      financials: [],
      dataAvailability: { hasFinancials: false, hasDocuments: false, hasDetailedDocs: false, hasCIM: false },
    }));
    await runMemo(['COMPANY_OVERVIEW', 'FINANCIAL_PERFORMANCE', 'QUALITY_OF_EARNINGS']);

    expect(sdkCalls.filter((c) => c.kind === 'create')).toHaveLength(0);
    expect(sectionCalls()).toHaveLength(1);
  });

  it('critique keeps effort high and sends the context uncached (one-shot, different prefix)', async () => {
    await runMemo(['EXECUTIVE_SUMMARY', 'RISK_ASSESSMENT']);

    const critique = sdkCalls.find((c) => c.kind === 'stream' && c.req.output_config?.format)!.req;
    expect(critique.output_config.effort).toBe('high');
    expect(typeof critique.messages[0].content).toBe('string');
    expect(prefixKey(critique)).toBeNull();
  });
});

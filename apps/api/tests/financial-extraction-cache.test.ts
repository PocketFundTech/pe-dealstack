/**
 * Financial Extraction Cache tests — Task 4.9.
 *
 * Verifies that re-extracting the same document content reuses the cached
 * result instead of re-paying the LLM cost.
 *
 *   1. First extraction → classifier called once → result stored in cache
 *   2. Second extraction with identical content → classifier NOT called → cache hit
 *   3. Different content hash → classifier called again
 *   4. Expired entry → classifier called again
 *   5. forceExtraction=true bypasses cache even on hit
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 4 Task 4.9
 * Refs: .planning/codebase/CONCERNS.md §3.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// ─── Supabase mock ───────────────────────────────────────────
// We model a single in-memory row store keyed by
// (contentHash, extractionMode, modelTier) so that the lookup-by-eq()
// chain returns the row that was last upserted with the same key.

interface CacheRow {
  id: string;
  contentHash: string;
  extractionMode: string;
  modelTier: string;
  result: any;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
  lastHitAt: string | null;
}

const cacheStore: CacheRow[] = [];

function findRow(filters: Record<string, any>): CacheRow | null {
  return (
    cacheStore.find((r) =>
      Object.entries(filters).every(([k, v]) => (r as any)[k] === v),
    ) ?? null
  );
}

function buildSelectChain(table: string) {
  const filters: Record<string, any> = {};
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: any) => {
      filters[col] = val;
      return chain;
    },
    maybeSingle: async () => {
      if (table !== 'FinancialExtractionCache') return { data: null, error: null };
      const row = findRow(filters);
      return { data: row, error: null };
    },
  };
  return chain;
}

function buildUpdateChain(table: string, patch: Record<string, any>) {
  const filters: Record<string, any> = {};
  const chain: any = {
    eq: (col: string, val: any) => {
      filters[col] = val;
      return chain;
    },
    then: (onFulfilled: any) => {
      if (table === 'FinancialExtractionCache') {
        const row = findRow(filters);
        if (row) Object.assign(row, patch);
      }
      return Promise.resolve({ error: null }).then(onFulfilled);
    },
  };
  return chain;
}

const supabaseMock = {
  from: (table: string) => ({
    select: (..._args: any[]) => buildSelectChain(table),
    update: (patch: Record<string, any>) => buildUpdateChain(table, patch),
    upsert: async (row: any) => {
      if (table !== 'FinancialExtractionCache') return { error: null };
      const idx = cacheStore.findIndex(
        (r) =>
          r.contentHash === row.contentHash &&
          r.extractionMode === row.extractionMode &&
          r.modelTier === row.modelTier,
      );
      const next: CacheRow = {
        id: `row-${cacheStore.length + 1}`,
        contentHash: row.contentHash,
        extractionMode: row.extractionMode,
        modelTier: row.modelTier,
        result: row.result,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        hitCount: row.hitCount ?? 0,
        lastHitAt: row.lastHitAt ?? null,
      };
      if (idx >= 0) cacheStore[idx] = next;
      else cacheStore.push(next);
      return { error: null };
    },
  }),
};

vi.mock('../src/supabase.js', () => ({
  supabase: supabaseMock,
}));

// Logger — silence noise.
vi.mock('../src/utils/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Suite: getCachedExtraction / putCachedExtraction ────────

describe('FinancialExtractionCache — put + get', () => {
  beforeEach(() => {
    cacheStore.length = 0;
  });

  it('stores and retrieves a result keyed by content hash', async () => {
    const { hashContent, getCachedExtraction, putCachedExtraction } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );

    const hash = hashContent(Buffer.from('hello-pdf-bytes'));
    const payload = {
      rawText: 'parsed text',
      extractionSource: 'gpt4o' as const,
      classification: { statements: [{ statementType: 'INCOME_STATEMENT' }], overallConfidence: 90, warnings: [] } as any,
      statements: [{ statementType: 'INCOME_STATEMENT' }] as any,
      overallConfidence: 90,
      warnings: [],
    };

    const stored = await putCachedExtraction({ contentHash: hash }, payload);
    expect(stored).toBe(true);

    const got = await getCachedExtraction({ contentHash: hash });
    expect(got).not.toBeNull();
    expect(got?.overallConfidence).toBe(90);
    expect(got?.extractionSource).toBe('gpt4o');
  });

  it('returns null on miss', async () => {
    const { getCachedExtraction, hashContent } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );
    const got = await getCachedExtraction({ contentHash: hashContent('nothing-cached-yet') });
    expect(got).toBeNull();
  });

  it('keys by (contentHash, extractionMode, modelTier) — different tier → miss', async () => {
    const { hashContent, getCachedExtraction, putCachedExtraction } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );
    const hash = hashContent('same-content');

    await putCachedExtraction(
      { contentHash: hash, modelTier: 'tier1' },
      {
        rawText: '',
        extractionSource: 'gpt4o',
        classification: { statements: [], overallConfidence: 50, warnings: [] } as any,
        statements: [],
        overallConfidence: 50,
        warnings: [],
      },
    );

    const same = await getCachedExtraction({ contentHash: hash, modelTier: 'tier1' });
    expect(same).not.toBeNull();

    const different = await getCachedExtraction({ contentHash: hash, modelTier: 'tier2' });
    expect(different).toBeNull();
  });

  it('returns null for expired entries', async () => {
    const { hashContent, getCachedExtraction, putCachedExtraction } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );
    const hash = hashContent('expiring-content');

    // TTL of 1ms — by the time we read it back below it will be stale.
    await putCachedExtraction(
      { contentHash: hash },
      {
        rawText: '',
        extractionSource: 'gpt4o',
        classification: { statements: [], overallConfidence: 70, warnings: [] } as any,
        statements: [],
        overallConfidence: 70,
        warnings: [],
      },
      1,
    );

    await new Promise((r) => setTimeout(r, 5));

    const got = await getCachedExtraction({ contentHash: hash });
    expect(got).toBeNull();
  });

  it('hashContent is stable for identical input and differs for different input', async () => {
    const { hashContent } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );
    const a = hashContent('the-same-bytes');
    const b = hashContent('the-same-bytes');
    const c = hashContent('different-bytes');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // Also verifies it is SHA-256 hex
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(createHash('sha256').update('the-same-bytes').digest('hex'));
  });
});

// ─── Suite: extractNode integration with the cache ───────────

// For extractNode we mock the classifier (to count calls) and the other
// extraction paths (LlamaParse off, vision returns nothing). We feed a PDF
// buffer through twice and assert the classifier is called once.

const classifyFinancialsMock = vi.fn();
const classifyVisionMock = vi.fn();
const isLlamaParseEnabledMock = vi.fn(() => false);
const parseWithLlamaMock = vi.fn();
const extractTextFromExcelMock = vi.fn();
const isExcelFileMock = vi.fn(() => true);

vi.mock('../src/services/financialClassifier.js', () => ({
  classifyFinancials: (...args: any[]) => classifyFinancialsMock(...args),
}));

// extractNode now routes classification through the cross-verified wrapper
// (main's financialCrossVerify.js) — mock it to the same underlying spy so
// cache-hit/miss assertions keep counting classifier invocations.
vi.mock('../src/services/financialCrossVerify.js', () => ({
  classifyFinancialsCrossVerified: (...args: any[]) => classifyFinancialsMock(...args),
}));

vi.mock('../src/services/visionExtractor.js', () => ({
  classifyFinancialsVision: (...args: any[]) => classifyVisionMock(...args),
}));

vi.mock('../src/services/llamaParse.js', () => ({
  isLlamaParseEnabled: () => isLlamaParseEnabledMock(),
  parseWithLlama: (...args: any[]) => parseWithLlamaMock(...args),
}));

vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: (...args: any[]) => extractTextFromExcelMock(...args),
  // extractNode now consumes the per-sheet API (main's multi-sheet refactor) —
  // derive a single synthetic sheet from the same text mock so the cache
  // assertions keep exercising the classify path.
  extractSheetsFromExcel: (...args: any[]) => {
    const text = extractTextFromExcelMock(...args);
    return text ? [{ name: 'Sheet1', text }] : [];
  },
  isExcelFile: (...args: any[]) => isExcelFileMock(...args),
}));

vi.mock('../src/services/documentChunker.js', () => ({
  chunkDocument: (text: string) => [{ text, relevanceScore: 1 }],
  mergeExtractionResults: (results: any[]) => results[0],
}));

// Drive extractNode down the Excel path — it doesn't use pdf-parse (CommonJS
// via createRequire, which vi.mock can't intercept). The Excel path still
// exercises the same cache wiring: hash buffer → check cache → call
// classifier on miss → store on success → return cached on hit.

describe('extractNode — cache integration', () => {
  beforeEach(() => {
    cacheStore.length = 0;
    classifyFinancialsMock.mockReset();
    classifyVisionMock.mockReset();
    parseWithLlamaMock.mockReset();
    extractTextFromExcelMock.mockReset();
    isLlamaParseEnabledMock.mockReset().mockReturnValue(false);
    isExcelFileMock.mockReset().mockReturnValue(true);
    // Default: Excel returns plenty of text so the path runs all the way through.
    extractTextFromExcelMock.mockReturnValue(
      'Income Statement\nRevenue 2023 100\n' + 'x'.repeat(200),
    );
  });

  function makeClassification() {
    return {
      statements: [
        {
          statementType: 'INCOME_STATEMENT',
          unitScale: 'MILLIONS',
          currency: 'USD',
          periods: [
            {
              period: '2023',
              periodType: 'HISTORICAL',
              lineItems: { revenue: 100 },
              confidence: 92,
            },
          ],
        },
      ],
      overallConfidence: 92,
      warnings: [],
    };
  }

  async function callExtract(buf: Buffer, opts?: { forceExtraction?: boolean }) {
    const { extractNode } = await import(
      '../src/services/agents/financialAgent/nodes/extractNode.js'
    );
    return extractNode({
      dealId: 'd1',
      documentId: 'doc1',
      fileBuffer: buf,
      fileName: 'model.xlsx',
      fileType: 'excel',
      organizationId: 'org1',
      forceExtraction: opts?.forceExtraction ?? false,
      // Other state fields aren't read by extractNode.
    } as any);
  }

  it('first call invokes the classifier and stores in cache; second call is a cache hit', async () => {
    classifyFinancialsMock.mockResolvedValue(makeClassification());

    const buf = Buffer.from('XLSX-IDENTICAL-CONTENT');

    const first = await callExtract(buf);
    expect(first.status).toBe('validating');
    expect(first.fromCache).toBe(false);
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(1);

    // Second call with same buffer — should hit the cache. Neither the Excel
    // parser nor the classifier should be invoked again.
    extractTextFromExcelMock.mockClear();
    classifyFinancialsMock.mockClear();

    const second = await callExtract(buf);
    expect(second.status).toBe('validating');
    expect(second.fromCache).toBe(true);
    expect(classifyFinancialsMock).not.toHaveBeenCalled();
    expect(extractTextFromExcelMock).not.toHaveBeenCalled();
    // Returned classification matches the cached one
    expect(second.overallConfidence).toBe(92);
    expect(second.statements?.length).toBe(1);
  });

  it('different content → classifier is called again', async () => {
    classifyFinancialsMock.mockResolvedValue(makeClassification());

    await callExtract(Buffer.from('content-A'));
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(1);

    await callExtract(Buffer.from('content-B'));
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(2);
  });

  it('forceExtraction=true bypasses cache even on hit', async () => {
    classifyFinancialsMock.mockResolvedValue(makeClassification());

    const buf = Buffer.from('same-bytes-again');

    await callExtract(buf);
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(1);

    // Now repeat with forceExtraction=true — classifier must be called again.
    classifyFinancialsMock.mockClear();
    extractTextFromExcelMock.mockClear();

    const result = await callExtract(buf, { forceExtraction: true });
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });

  it('expired cache entry triggers re-extraction', async () => {
    classifyFinancialsMock.mockResolvedValue(makeClassification());

    const buf = Buffer.from('expiring-buffer-content');

    // Seed cache directly with an already-expired row.
    const { hashContent } = await import(
      '../src/services/agents/financialAgent/extractionCache.js'
    );
    cacheStore.push({
      id: 'pre-1',
      contentHash: hashContent(buf),
      extractionMode: 'default',
      modelTier: 'tier1',
      result: {
        rawText: 'stale',
        extractionSource: 'gpt4o',
        classification: { statements: [{ statementType: 'INCOME_STATEMENT' }], overallConfidence: 1, warnings: [] },
        statements: [{ statementType: 'INCOME_STATEMENT' }],
        overallConfidence: 1,
        warnings: [],
      },
      createdAt: new Date(Date.now() - 1_000_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
      hitCount: 0,
      lastHitAt: null,
    });

    const result = await callExtract(buf);
    expect(classifyFinancialsMock).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    // The fresh result (confidence 92), not the stale one (confidence 1).
    expect(result.overallConfidence).toBe(92);
  });
});

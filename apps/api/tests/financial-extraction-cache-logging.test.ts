/**
 * Cache failures must be visible. For 14 days in production the cache
 * never stored or hit anything (its table had not been created) and nobody
 * knew, because every failure was logged at debug level — so every
 * re-extract paid full price (CSP, 15 Oct 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let lookupError: { message: string } | null = null;
let upsertError: { message: string } | null = null;

const chain = (result: () => { data: any; error: any }) => {
  const b: any = {};
  for (const m of ['select', 'eq', 'update', 'order', 'limit']) b[m] = () => b;
  b.maybeSingle = async () => result();
  b.single = async () => result();
  b.upsert = () => ({ ...b, then: (res: any) => Promise.resolve(result()).then(res) });
  b.then = (res: any) => Promise.resolve(result()).then(res);
  return b;
};
vi.mock('../src/supabase.js', () => ({
  supabase: { from: () => chain(() => (upsertError ? { data: null, error: upsertError } : { data: null, error: lookupError })) },
}));
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('../src/utils/logger.js', () => ({ log }));

beforeEach(() => { lookupError = null; upsertError = null; for (const f of Object.values(log)) f.mockClear(); });

const key = { contentHash: 'a'.repeat(64), extractionMode: 'claude', modelTier: 'claude-fable-5@v4' };

describe('FinancialExtractionCache failures are logged as warnings', () => {
  it('a lookup error (e.g. missing table) is a warning, not a debug line', async () => {
    const { getCachedExtraction } = await import('../src/services/agents/financialAgent/extractionCache.js');
    lookupError = { message: 'relation "FinancialExtractionCache" does not exist' };
    expect(await getCachedExtraction(key)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/FinancialExtractionCache lookup/), expect.objectContaining({ error: lookupError.message }));
  });

  it('a failed store is a warning, not a debug line', async () => {
    const { putCachedExtraction } = await import('../src/services/agents/financialAgent/extractionCache.js');
    upsertError = { message: 'relation "FinancialExtractionCache" does not exist' };
    await putCachedExtraction(key, {
      rawText: 'x', extractionSource: 'claude' as any, classification: { statements: [], overallConfidence: 0, warnings: [] } as any,
      statements: [], overallConfidence: 0, warnings: [],
    } as any);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/FinancialExtractionCache upsert/), expect.objectContaining({ error: upsertError.message }));
  });
});

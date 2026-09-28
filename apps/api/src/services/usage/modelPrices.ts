import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';

export interface ModelPriceRow {
  inputPricePer1M: number;
  outputPricePer1M: number;
  /** Provider from the ModelPrice row — decides the default cache multipliers. */
  provider?: string;
  /** Explicit cache prices (usage-cost-accuracy migration). null/undefined → default multiplier. */
  cacheReadPricePer1M?: number | null;
  cacheWrite5mPricePer1M?: number | null;
  cacheWrite1hPricePer1M?: number | null;
}

/**
 * Cache token counts, reported separately from `input_tokens`.
 * Anthropic's `usage.input_tokens` EXCLUDES cached tokens, so these must be
 * added on top — otherwise a prompt-cached call drops most of its real input
 * from the bill.
 */
export interface CacheTokenCounts {
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/**
 * Anthropic list multipliers on the base input price (Claude API reference,
 * prompt caching § Economics): cache read 0.1x, 5-minute write 1.25x, 1-hour
 * write 2x. Models that differ (claude-fable-5-1 reads at 0.025x = $0.25/MTok)
 * set an explicit price in the ModelPrice row, which wins.
 */
const ANTHROPIC_CACHE_MULTIPLIERS = { read: 0.1, write5m: 1.25, write1h: 2 };
/**
 * Other providers: we don't guess a discount (OpenAI's cached-input discount
 * varies by model). Cache tokens are priced at the full input rate — a small,
 * conservative overcount rather than an undercount.
 */
const FULL_PRICE_MULTIPLIERS = { read: 1, write5m: 1, write1h: 1 };

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let cache: Map<string, ModelPriceRow> | null = null;
let cacheLoadedAt = 0;
let loadingPromise: Promise<void> | null = null;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadCache(): Promise<void> {
  // select('*'): the cache-price columns only exist after the
  // usage-cost-accuracy migration runs. Naming them explicitly would make the
  // whole price load fail (and every cost $0) until then.
  const { data, error } = await supabase.from('ModelPrice').select('*');

  if (error) {
    log.error('modelPrices: failed to load', error);
    return;
  }
  cache = new Map();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    cache.set(String(row.model), {
      inputPricePer1M: Number(row.inputPricePer1M),
      outputPricePer1M: Number(row.outputPricePer1M),
      provider: typeof row.provider === 'string' ? row.provider : undefined,
      cacheReadPricePer1M: num(row.cacheReadPricePer1M),
      cacheWrite5mPricePer1M: num(row.cacheWrite5mPricePer1M),
      cacheWrite1hPricePer1M: num(row.cacheWrite1hPricePer1M),
    });
  }
  cacheLoadedAt = Date.now();
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. Served ids carry dated snapshots. */
const DATE_SUFFIX = /-\d{8}$/;

export async function getModelPrice(model: string): Promise<ModelPriceRow | null> {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    if (!loadingPromise) {
      loadingPromise = loadCache().finally(() => { loadingPromise = null; });
    }
    await loadingPromise;
  }
  const exact = cache?.get(model);
  if (exact) return exact;
  if (DATE_SUFFIX.test(model)) return cache?.get(model.replace(DATE_SUFFIX, '')) ?? null;
  return null;
}

export function computeCostUsd(
  price: ModelPriceRow | null,
  promptTokens: number,
  completionTokens: number,
  cacheTokens: CacheTokenCounts = {},
): number {
  if (!price) return 0;
  const m = price.provider === 'anthropic' ? ANTHROPIC_CACHE_MULTIPLIERS : FULL_PRICE_MULTIPLIERS;
  const input = price.inputPricePer1M;
  const readPrice = price.cacheReadPricePer1M ?? input * m.read;
  const write5mPrice = price.cacheWrite5mPricePer1M ?? input * m.write5m;
  const write1hPrice = price.cacheWrite1hPricePer1M ?? input * m.write1h;
  return (
    (promptTokens / 1_000_000) * input +
    (completionTokens / 1_000_000) * price.outputPricePer1M +
    ((cacheTokens.cacheReadTokens ?? 0) / 1_000_000) * readPrice +
    ((cacheTokens.cacheWrite5mTokens ?? 0) / 1_000_000) * write5mPrice +
    ((cacheTokens.cacheWrite1hTokens ?? 0) / 1_000_000) * write1hPrice
  );
}

/** Test-only: reset the in-memory cache so tests don't leak state. */
export function _resetModelPriceCache(): void {
  cache = null;
  cacheLoadedAt = 0;
  loadingPromise = null;
}

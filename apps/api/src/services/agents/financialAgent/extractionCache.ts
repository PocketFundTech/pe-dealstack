/**
 * Financial Extraction Cache
 *
 * Caches the result of expensive financial extraction calls
 * (OpenAI GPT-4o classifier, Vision, LlamaParse) keyed by the SHA-256 of the
 * post-OCR document content + the extraction mode + the model tier. Re-running
 * extraction on the same document (re-uploaded or "re-extract" pressed) returns
 * the cached classification instead of re-paying ~$0.75-$1.50/run.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 4 Task 4.9
 * Refs: .planning/codebase/CONCERNS.md §3.4
 *
 * Storage: public."FinancialExtractionCache" table (see
 * apps/api/financial-extraction-cache-migration.sql). The cache is DB-backed
 * because Vercel serverless instances are stateless — an in-memory cache
 * would have near-zero hit rate across requests.
 */

import { createHash } from 'crypto';
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import type { ClassificationResult } from '../../financialClassifier.js';
import type { ExtractionSource } from './state.js';

// 30-day TTL: extraction results for an unchanged document are valid
// effectively forever. 30 days protects against schema/prompt evolution while
// still capturing 99%+ of re-extraction traffic.
export const EXTRACTION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Payload stored in the `result` JSONB column. */
export interface CachedExtractionResult {
  rawText: string;
  extractionSource: ExtractionSource;
  classification: ClassificationResult | null;
  /** Convenience: classification.statements (mirrors agent state.statements) */
  statements: ClassificationResult['statements'];
  /** Convenience: classification.overallConfidence */
  overallConfidence: number;
  /** Convenience: classification.warnings */
  warnings: string[];
}

/** Hash inputs that uniquely identify an extraction request. */
export interface ExtractionCacheKey {
  /** SHA-256 hex of the canonical content (post-OCR text or raw bytes). */
  contentHash: string;
  /**
   * Logical extraction mode. Originally reserved for a fast/deep split
   * (still unimplemented); also now carries the active extraction ENGINE
   * ('default' for legacy, 'claude' for EXTRACTION_ENGINE=claude — see
   * extractNode.ts) so a document cached under one engine is never served
   * to the other. A future fast/deep split will need to compose with this.
   */
  extractionMode?: string;
  /** Model tier (e.g. classification model name). Cache invalidates when the model changes. */
  modelTier?: string;
}

const DEFAULT_MODE = 'default';
const DEFAULT_TIER = 'tier1';

/** Compute the SHA-256 hex digest of a string or Buffer. */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Look up a cached extraction result.
 * Returns null on miss, on expired entry, or on any error
 * (cache lookup must never break the extraction pipeline).
 */
export async function getCachedExtraction(
  key: ExtractionCacheKey,
): Promise<CachedExtractionResult | null> {
  const extractionMode = key.extractionMode ?? DEFAULT_MODE;
  const modelTier = key.modelTier ?? DEFAULT_TIER;

  try {
    const { data, error } = await supabase
      .from('FinancialExtractionCache')
      .select('id, result, expiresAt, hitCount')
      .eq('contentHash', key.contentHash)
      .eq('extractionMode', extractionMode)
      .eq('modelTier', modelTier)
      .maybeSingle();

    if (error) {
      log.debug('FinancialExtractionCache lookup error', { error: error.message });
      return null;
    }

    if (!data) {
      log.debug('FinancialExtractionCache miss', {
        contentHash: key.contentHash.slice(0, 12),
        extractionMode,
        modelTier,
      });
      return null;
    }

    // Expired?
    if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
      log.debug('FinancialExtractionCache expired', {
        contentHash: key.contentHash.slice(0, 12),
        expiresAt: data.expiresAt,
      });
      return null;
    }

    // Best-effort hit counter update (don't await — fire and forget).
    void supabase
      .from('FinancialExtractionCache')
      .update({
        hitCount: (data.hitCount ?? 0) + 1,
        lastHitAt: new Date().toISOString(),
      })
      .eq('id', data.id)
      .then((res) => {
        if (res.error) {
          log.debug('FinancialExtractionCache hitCount update failed', {
            error: res.error.message,
          });
        }
      });

    log.info('FinancialExtractionCache hit', {
      contentHash: key.contentHash.slice(0, 12),
      extractionMode,
      modelTier,
      hitCount: (data.hitCount ?? 0) + 1,
    });

    return data.result as CachedExtractionResult;
  } catch (err) {
    log.debug('FinancialExtractionCache lookup threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Persist (or refresh) a cached extraction result.
 * Uses upsert on the (contentHash, extractionMode, modelTier) unique index so
 * an expired entry is refreshed in-place rather than duplicated.
 *
 * Returns true on success, false on any error. Cache writes must never break
 * the extraction pipeline — the caller already has the live result.
 */
export async function putCachedExtraction(
  key: ExtractionCacheKey,
  result: CachedExtractionResult,
  ttlMs: number = EXTRACTION_CACHE_TTL_MS,
): Promise<boolean> {
  const extractionMode = key.extractionMode ?? DEFAULT_MODE;
  const modelTier = key.modelTier ?? DEFAULT_TIER;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  try {
    const { error } = await supabase
      .from('FinancialExtractionCache')
      .upsert(
        {
          contentHash: key.contentHash,
          extractionMode,
          modelTier,
          result,
          createdAt: now.toISOString(),
          expiresAt,
          hitCount: 0,
          lastHitAt: null,
        },
        { onConflict: 'contentHash,extractionMode,modelTier' },
      );

    if (error) {
      log.debug('FinancialExtractionCache upsert failed', { error: error.message });
      return false;
    }

    log.info('FinancialExtractionCache stored', {
      contentHash: key.contentHash.slice(0, 12),
      extractionMode,
      modelTier,
      expiresAt,
    });
    return true;
  } catch (err) {
    log.debug('FinancialExtractionCache upsert threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

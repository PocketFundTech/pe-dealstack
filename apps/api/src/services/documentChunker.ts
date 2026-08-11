/**
 * Document Chunker — splits large documents into overlapping chunks
 * for financial extraction from big CIMs (50+ pages, 500K+ chars).
 *
 * Strategy:
 *  1. Split at known section header boundaries
 *  2. Add 2K char overlap between consecutive chunks
 *  3. Sort chunks by financial keyword relevance so high-value chunks
 *     are processed first (caller can slice to cap cost)
 */

import type { ClassifiedStatement } from './financialClassifier.js';

// ─── Types ────────────────────────────────────────────────────

export interface ClassificationResult {
  statements: ClassifiedStatement[];
  overallConfidence: number;
  warnings: string[];
}

export interface Chunk {
  text: string;
  /** 0-based index in original document order */
  index: number;
  /** 0-100 financial relevance score */
  relevanceScore: number;
  /** Character offset where this chunk starts in the original text */
  startOffset: number;
}

// ─── Constants ────────────────────────────────────────────────

const OVERLAP_SIZE = 2000;

/**
 * Section header patterns that indicate natural document boundaries.
 * Sorted from most-financial to least to ensure we split at meaningful spots.
 */
const SECTION_HEADER_PATTERN = new RegExp(
  [
    // Financial sections
    /financial\s+summary/,
    /income\s+statement/,
    /profit\s+(and|&)\s+loss/,
    /p\s*[&+]\s*l/,
    /balance\s+sheet/,
    /cash\s+flow/,
    /statement\s+of\s+cash/,
    /financial\s+statements?/,
    /financial\s+highlights/,
    /financial\s+performance/,
    /historical\s+financials?/,
    /projected\s+financials?/,
    /revenue\s+summary/,
    /ebitda/,
    // Document sections
    /appendix/,
    /exhibit\s+[a-z0-9]/,
    /schedule\s+[a-z0-9]/,
    /section\s+[0-9ivx]+/,
    /chapter\s+[0-9ivx]+/,
    /executive\s+summary/,
    /business\s+overview/,
    /management\s+discussion/,
    /table\s+of\s+contents/,
  ]
    .map(r => r.source)
    .join('|'),
  'im',
);

/** Financial keywords used for relevance scoring */
const FINANCIAL_KEYWORDS: ReadonlyArray<string> = [
  'revenue',
  'ebitda',
  'ebit',
  'gross profit',
  'gross margin',
  'net income',
  'operating income',
  'cash flow',
  'free cash flow',
  'balance sheet',
  'income statement',
  'profit and loss',
  'total assets',
  'total liabilities',
  'equity',
  'capex',
  'depreciation',
  'amortization',
  'interest expense',
  'net debt',
  'working capital',
  'accounts receivable',
  'accounts payable',
  'inventory',
  'margin',
  'cogs',
  'sga',
  'fiscal year',
  'fy20',
  'fy21',
  'fy22',
  'fy23',
  'fy24',
  'ltm',
  'ttm',
  'budget',
  'forecast',
  '$',
  '€',
  '£',
  '₹',
];

// ─── Public API ───────────────────────────────────────────────

/**
 * Splits `text` into overlapping chunks at natural section boundaries.
 * Returns a single chunk for text shorter than `maxChunkSize`.
 * Chunks are sorted by relevance score (highest first).
 */
export function chunkDocument(text: string, maxChunkSize: number = 100000): Chunk[] {
  if (!text || text.length === 0) {
    return [];
  }

  if (text.length <= maxChunkSize) {
    return [
      {
        text,
        index: 0,
        relevanceScore: scoreChunkRelevance(text),
        startOffset: 0,
      },
    ];
  }

  // Find all section boundary positions
  const boundaries = findSectionBoundaries(text);

  // Build raw chunks respecting maxChunkSize
  const rawChunks = buildChunks(text, boundaries, maxChunkSize);

  // Add overlap and score
  const scored = rawChunks.map((chunk, i) => ({
    ...chunk,
    index: i,
    relevanceScore: scoreChunkRelevance(chunk.text),
  }));

  // Sort by relevance descending so callers can slice to top-N
  return scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/**
 * Returns a 0-100 score based on financial keyword density.
 * Higher = more likely to contain financial tables.
 */
export function scoreChunkRelevance(text: string): number {
  if (!text || text.length === 0) return 0;

  const lower = text.toLowerCase();
  let matchCount = 0;

  for (const kw of FINANCIAL_KEYWORDS) {
    if (lower.includes(kw)) {
      matchCount += 1;
    }
  }

  // Normalise against keyword list length, scale to 0-100
  const density = matchCount / FINANCIAL_KEYWORDS.length;
  return Math.round(Math.min(density * 100 * 2.5, 100)); // 2.5x multiplier so 40% hit = 100
}

/**
 * Merges ClassificationResult arrays from multiple chunks.
 * - Deduplicates: one entry per (statementType, period) pair
 * - When two chunks have the same period, keeps higher confidence
 * - When values disagree by >1%, adds a warning
 */
export function mergeExtractionResults(results: ClassificationResult[]): ClassificationResult {
  if (results.length === 0) {
    return { statements: [], overallConfidence: 0, warnings: [] };
  }
  if (results.length === 1) {
    return results[0];
  }

  const warnings: string[] = [];

  // Collect all warnings from constituent results
  for (const r of results) {
    warnings.push(...r.warnings);
  }

  // Map: statementType → Map<period, { lineItems, confidence, unitScale, currency }>
  type PeriodEntry = {
    lineItems: Record<string, number | null>;
    confidence: number;
    unitScale: string;
    currency: string;
  };

  const statementMap = new Map<string, Map<string, PeriodEntry>>();

  for (const result of results) {
    for (const stmt of result.statements) {
      if (!statementMap.has(stmt.statementType)) {
        statementMap.set(stmt.statementType, new Map());
      }
      const periodMap = statementMap.get(stmt.statementType)!;

      for (const period of stmt.periods) {
        const existing = periodMap.get(period.period);

        if (!existing) {
          periodMap.set(period.period, {
            lineItems: { ...period.lineItems },
            confidence: period.confidence,
            unitScale: stmt.unitScale,
            currency: stmt.currency,
          });
        } else {
          // Conflict resolution
          if (period.confidence > existing.confidence) {
            // Check if values agree within 1%
            const disagreements = findDisagreements(existing.lineItems, period.lineItems);
            if (disagreements.length > 0) {
              warnings.push(
                `${stmt.statementType} period ${period.period}: conflicting values for ${disagreements.join(', ')} — kept higher-confidence version`,
              );
            }
            // Replace with higher-confidence version
            periodMap.set(period.period, {
              lineItems: { ...period.lineItems },
              confidence: period.confidence,
              unitScale: stmt.unitScale,
              currency: stmt.currency,
            });
          }
          // else keep existing (it already has higher confidence)
        }
      }
    }
  }

  // Rebuild ClassifiedStatement array
  const statements: ClassifiedStatement[] = [];

  for (const [statementType, periodMap] of statementMap.entries()) {
    // Determine dominant currency/unitScale from first entry
    const firstEntry = periodMap.values().next().value as PeriodEntry | undefined;
    // Default to ACTUALS rather than MILLIONS when no chunk supplied a unit —
    // safer because it means "do not multiply" and matches the new
    // preserve-source-scale policy (financialClassifier.normalizeUnitScale).
    const unitScale = (firstEntry?.unitScale ?? 'ACTUALS') as ClassifiedStatement['unitScale'];
    const currency = firstEntry?.currency ?? 'USD';

    statements.push({
      statementType: statementType as ClassifiedStatement['statementType'],
      unitScale,
      currency,
      periods: Array.from(periodMap.entries()).map(([period, entry]) => ({
        period,
        periodType: detectPeriodType(period),
        lineItems: entry.lineItems,
        confidence: entry.confidence,
      })),
    });
  }

  const overallConfidence =
    results.reduce((sum, r) => sum + r.overallConfidence, 0) / results.length;

  return {
    statements,
    overallConfidence: Math.round(overallConfidence),
    warnings: deduplicateWarnings(warnings),
  };
}

// ─── Private Helpers ─────────────────────────────────────────

/** Find character offsets of all section header matches */
function findSectionBoundaries(text: string): number[] {
  const boundaries: number[] = [0];
  const re = new RegExp(SECTION_HEADER_PATTERN.source, 'gim');
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // Find the start of the line containing this match
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    if (lineStart > 0 && !boundaries.includes(lineStart)) {
      boundaries.push(lineStart);
    }
  }

  boundaries.sort((a, b) => a - b);
  return boundaries;
}

/** Build chunks from text by grouping sections up to maxChunkSize with overlap */
function buildChunks(
  text: string,
  boundaries: number[],
  maxChunkSize: number,
): Array<{ text: string; startOffset: number }> {
  const chunks: Array<{ text: string; startOffset: number }> = [];

  let chunkStart = 0;

  while (chunkStart < text.length) {
    const chunkEnd = Math.min(chunkStart + maxChunkSize, text.length);

    // Try to break at the last section boundary before chunkEnd
    const breakPoint = findBestBreakPoint(boundaries, chunkStart, chunkEnd, text.length);

    const chunkText = text.slice(chunkStart, breakPoint);
    chunks.push({ text: chunkText, startOffset: chunkStart });

    if (breakPoint >= text.length) break;

    // Next chunk starts with overlap to preserve context across boundaries
    chunkStart = Math.max(breakPoint - OVERLAP_SIZE, chunkStart + 1);
  }

  return chunks;
}

/**
 * Find the best break point: last section boundary inside [start, end],
 * or end if no boundary found.
 */
function findBestBreakPoint(
  boundaries: number[],
  chunkStart: number,
  chunkEnd: number,
  textLength: number,
): number {
  if (chunkEnd >= textLength) return textLength;

  // Find the last boundary strictly inside the window
  let best = chunkEnd;
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const b = boundaries[i];
    if (b > chunkStart && b < chunkEnd) {
      best = b;
      break;
    }
  }

  return best;
}

/** Detect period type from period string */
function detectPeriodType(period: string): 'HISTORICAL' | 'PROJECTED' | 'LTM' {
  const upper = period.toUpperCase();
  if (upper === 'LTM' || upper === 'TTM') return 'LTM';
  if (/[EFe]$/.test(period) || /EST|FORECAST|BUDGET|PROJ/i.test(period)) return 'PROJECTED';
  return 'HISTORICAL';
}

/** Find line item keys where two records disagree by >1% */
function findDisagreements(
  a: Record<string, number | null>,
  b: Record<string, number | null>,
): string[] {
  const disagreements: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of keys) {
    const va = a[key];
    const vb = b[key];

    if (va === null || vb === null) continue;
    if (va === 0 && vb === 0) continue;

    const denom = Math.max(Math.abs(va), Math.abs(vb));
    if (denom === 0) continue;

    const diff = Math.abs(va - vb) / denom;
    if (diff > 0.01) {
      disagreements.push(key);
    }
  }

  return disagreements;
}

/** Remove duplicate warning strings */
function deduplicateWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

/**
 * visionExtractor.ts — GPT-4.1 Vision fallback for scanned / image-only PDFs.
 *
 * When pdf-parse returns < 200 meaningful characters (scanned PDFs, image PDFs),
 * this service uploads the raw PDF buffer to OpenAI and sends it to GPT-4.1
 * using the Responses API, which natively supports PDF file inputs.
 *
 * Returns the same ClassificationResult format as classifyFinancials()
 * so the rest of the pipeline is unchanged.
 */

import { openaiDirect, trackedDirectResponsesCreate } from '../openai.js';
import { log } from '../utils/logger.js';
import { buildExtractionPrompt } from './extractionPrompt.js';
import { getTodayIso } from '../utils/dates.js';
import type { ClassificationResult, ClassifiedStatement, FinancialPeriod, StatementType, PeriodType, UnitScale } from './financialClassifier.js';

// ─── System prompt (same intent as classifyFinancials, optimised for vision) ──
// Prompt is built via shared extractionPrompt.ts — single source of truth.

// ─── Main export ───────────────────────────────────────────────

/**
 * Attempt to extract financial statements from a PDF buffer using
 * GPT-4.1's native PDF reading (via Responses API).
 *
 * Use this when pdf-parse yields fewer than ~200 meaningful characters
 * (scanned PDFs, image-based PDFs).
 */
export async function classifyFinancialsVision(
  pdfBuffer: Buffer,
  filename: string = 'document.pdf',
  currencyHint?: string,
): Promise<ClassificationResult | null> {
  if (!openaiDirect) {
    log.warn('Vision extractor: direct OpenAI key not configured (Responses API requires it, OpenRouter does not proxy /v1/responses), skipping');
    return null;
  }

  if (!pdfBuffer || pdfBuffer.length === 0) {
    log.warn('Vision extractor: empty PDF buffer');
    return null;
  }

  log.info('Vision extractor: starting vision extraction', {
    filename,
    bufferSizeKB: Math.round(pdfBuffer.length / 1024),
  });

  try {
    // Encode PDF as base64 data URL — Responses API accepts this directly
    const base64 = pdfBuffer.toString('base64');
    const fileDataUrl = `data:application/pdf;base64,${base64}`;

    // Use the Responses API which natively supports PDF file inputs.
    // Must hit OpenAI directly — OpenRouter does not proxy /v1/responses.
    const response = await trackedDirectResponsesCreate('financial_extraction', {
      model: 'gpt-4.1',
      instructions: buildExtractionPrompt({ includeSourceCitations: false, currencyHint, todayIso: getTodayIso() }),
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename,
              file_data: fileDataUrl,
            },
            {
              type: 'input_text',
              text: 'Extract all financial statements from this document and return JSON.',
            },
          ],
        },
      ],
      text: { format: { type: 'json_object' } },
    });

    const content: string | null = response.output_text ?? null;

    if (!content) {
      log.error('Vision extractor: empty response from vision model');
      return null;
    }

    const raw = JSON.parse(content) as ClassificationResult;
    const result = normalizeVisionResult(raw);

    log.info('Vision extractor: completed', {
      filename,
      statementsFound: result.statements.length,
      overallConfidence: result.overallConfidence,
    });

    return result;
  } catch (err: any) {
    // If Responses API is not available, log clearly and return null
    if (err?.status === 404 || err?.message?.includes('responses')) {
      log.error('Vision extractor: Responses API not available on this OpenAI account/key', err.message);
    } else {
      log.error('Vision extractor: unexpected error', err);
    }
    return null;
  }
}

// ─── Normalization (mirrors financialClassifier.ts) ───────────

function normalizeVisionResult(raw: any): ClassificationResult {
  const warnings: string[] = Array.isArray(raw.warnings) ? raw.warnings : [];
  const statements: ClassifiedStatement[] = [];

  if (!Array.isArray(raw.statements)) {
    return { statements: [], overallConfidence: 0, warnings: ['Vision: unexpected response format'] };
  }

  for (const stmt of raw.statements) {
    const statementType = normalizeStatementType(stmt.statementType);
    if (!statementType) {
      warnings.push(`Vision: unknown statement type: ${stmt.statementType}`);
      continue;
    }

    const periods: FinancialPeriod[] = [];

    if (Array.isArray(stmt.periods)) {
      for (const p of stmt.periods) {
        if (!p.period) continue;
        periods.push({
          period: String(p.period).trim(),
          periodType: normalizePeriodType(p.periodType),
          lineItems: normalizeLineItems(p.lineItems ?? {}),
          confidence: clamp(Number(p.confidence) || 0, 0, 100),
        });
      }
    }

    if (periods.length === 0) {
      warnings.push(`Vision: no periods for ${statementType}`);
      continue;
    }

    statements.push({
      statementType,
      unitScale: normalizeUnitScale(stmt.unitScale),
      currency: stmt.currency || 'USD',
      periods,
    });
  }

  return {
    statements,
    overallConfidence: clamp(Number(raw.overallConfidence) || 0, 0, 100),
    warnings,
  };
}

function normalizeStatementType(raw: string): StatementType | null {
  const map: Record<string, StatementType> = {
    INCOME_STATEMENT: 'INCOME_STATEMENT',
    BALANCE_SHEET: 'BALANCE_SHEET',
    CASH_FLOW: 'CASH_FLOW',
  };
  return map[String(raw ?? '').toUpperCase().trim()] ?? null;
}

function normalizePeriodType(raw: string): PeriodType {
  const map: Record<string, PeriodType> = {
    HISTORICAL: 'HISTORICAL',
    PROJECTED: 'PROJECTED',
    LTM: 'LTM',
  };
  return map[String(raw ?? '').toUpperCase().trim()] ?? 'HISTORICAL';
}

function normalizeUnitScale(raw: string): UnitScale {
  const map: Record<string, UnitScale> = {
    MILLIONS: 'MILLIONS',
    THOUSANDS: 'THOUSANDS',
    ACTUALS: 'ACTUALS',
    BILLIONS: 'BILLIONS',
  };
  const key = String(raw ?? '').toUpperCase().trim();
  const matched = map[key];
  if (matched) return matched;
  // Mirror financialClassifier.normalizeUnitScale: unknown/missing → ACTUALS
  // (no silent ×1,000,000 inflation) and warn so model regressions surface.
  if (key !== '') {
    log.warn('Vision extractor: unknown unitScale from LLM, defaulting to ACTUALS', { raw });
  }
  return 'ACTUALS';
}

function normalizeLineItems(raw: Record<string, any>): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined) {
      result[key] = null;
    } else {
      const num = Number(val);
      result[key] = isNaN(num) ? null : num;
    }
  }
  return result;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

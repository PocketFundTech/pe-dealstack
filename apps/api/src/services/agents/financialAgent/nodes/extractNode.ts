/**
 * Extract Node — LangGraph node for the financial extraction agent.
 *
 * Routes the file to the best extraction layer:
 *   Excel → xlsx parser → CSV text → AI classifier (MODEL_CLASSIFICATION)
 *   PDF Layer 1 → LlamaParse structured markdown (if configured)
 *   PDF Layer 2 → pdf-parse text → AI classifier (MODEL_CLASSIFICATION)
 *   PDF Layer 3 → GPT-4.1 Vision (scanned/image PDFs)
 *
 * Wraps existing service functions — no extraction logic is duplicated.
 */

import { createRequire } from 'module';
import { classifyFinancials } from '../../../financialClassifier.js';
import { classifyFinancialsVision } from '../../../visionExtractor.js';
import { chunkDocument, mergeExtractionResults } from '../../../documentChunker.js';
import type { ClassificationResult } from '../../../documentChunker.js';
import { extractTextFromExcel, isExcelFile } from '../../../excelFinancialExtractor.js';
import { parseWithLlama, isLlamaParseEnabled } from '../../../llamaParse.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import type { FinancialAgentStateType } from '../state.js';
import type { ExtractionSource, AgentStep } from '../state.js';
import { CHUNK_THRESHOLD, MAX_CHUNK_SIZE, MAX_CHUNKS, MIN_TEXT_LENGTH } from '../config.js';
import {
  getCachedExtraction,
  putCachedExtraction,
  hashContent,
  type CachedExtractionResult,
} from '../extractionCache.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

/** Create a timestamped agent step */
function step(node: string, message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node, message, detail };
}

/**
 * LangGraph Extract Node
 *
 * Reads: fileBuffer, fileName, fileType
 * Writes: rawText, extractionSource, classification, statements,
 *         overallConfidence, warnings, status, steps
 */
export async function extractNode(
  state: FinancialAgentStateType,
): Promise<Partial<FinancialAgentStateType>> {
  const steps: AgentStep[] = [];
  const { fileBuffer, fileName, fileType, forceExtraction } = state;

  if (!fileBuffer || fileBuffer.length === 0) {
    return {
      status: 'failed',
      error: 'No file buffer provided',
      steps: [step('extract', 'Failed: no file buffer provided')],
    };
  }

  steps.push(step('extract', `Received ${fileName} (${fileType}, ${(fileBuffer.length / 1024).toFixed(0)}KB)`));

  // ── Cache check (Task 4.9) ──────────────────────────────────
  // Hash the file buffer so the same bytes — re-uploaded as a new document
  // or re-extracted via the route — hit the cache regardless of which
  // extraction layer (Excel/LlamaParse/pdf-parse/Vision) succeeded.
  const contentHash = hashContent(fileBuffer);
  // Single source of truth for the engine flag — read once so the cache-key
  // dimension below and the branch condition later can never drift apart
  // (two independent reads of the same env var previously re-opened the
  // exact cross-engine cache-poisoning gap this was written to close).
  const useClaudeEngine = (process.env.EXTRACTION_ENGINE || 'legacy') === 'claude';
  // Cache key includes the active engine so a document cached by one engine
  // is never silently served to the other — critical for both the rollout
  // (flag ON must not skip the new engine due to a stale legacy cache hit)
  // and rollback (flag OFF must not keep serving claude-flavored cached
  // state). extractionMode's own doc comment currently describes a fast/deep
  // split reservation; this field is now overloaded to also carry the engine
  // dimension — a future fast/deep split will need to compose with this.
  const engineMode = useClaudeEngine ? 'claude' : 'default';

  if (!forceExtraction) {
    const cached = await getCachedExtraction({ contentHash, extractionMode: engineMode });
    if (cached) {
      steps.push(step('extract', `Cache hit — skipping LLM extraction (saved ~$0.75-$1.50)`));
      return {
        rawText: cached.rawText,
        extractionSource: cached.extractionSource,
        classification: cached.classification,
        statements: cached.statements,
        overallConfidence: cached.overallConfidence,
        warnings: cached.warnings,
        fromCache: true,
        status: 'validating',
        steps,
      };
    }
  } else {
    steps.push(step('extract', 'forceExtraction=true — bypassing extraction cache'));
  }

  /** Persist a successful extraction to the cache (best-effort). */
  const cacheResult = (payload: CachedExtractionResult): void => {
    if (!payload.classification || payload.statements.length === 0) return;
    void putCachedExtraction({ contentHash, extractionMode: engineMode }, payload).catch(() => {
      // Errors already logged inside putCachedExtraction; swallow here.
    });
  };

  try {
    // ── Claude structured-output engine (Phase 1, EXTRACTION_ENGINE=claude) ──
    if (useClaudeEngine) {
      steps.push(step('extract', 'EXTRACTION_ENGINE=claude — using structured-output engine'));
      const { extractWithClaude } = await import('../../../extraction/claudeEngine.js');
      const engineResult = await extractWithClaude({ fileBuffer, fileName, fileType });

      if (!engineResult) {
        return {
          status: 'failed',
          error: 'Claude engine could not extract this document (upload failed or the request was declined)',
          steps: [...steps, step('extract', 'Claude engine returned no result')],
        };
      }

      if (engineResult.classification.statements.length === 0) {
        // Matches the legacy convention (see the Excel/Vision "no financial
        // data found" paths below): a genuinely empty extraction is a
        // successful, completed run with zero data — not a pipeline failure.
        cacheResult({
          rawText: engineResult.rawText,
          extractionSource: 'claude',
          classification: engineResult.classification,
          statements: [],
          overallConfidence: 0,
          warnings: engineResult.classification.warnings,
        });
        return {
          rawText: engineResult.rawText,
          extractionSource: 'claude',
          classification: engineResult.classification,
          statements: [],
          overallConfidence: 0,
          warnings: engineResult.classification.warnings.length > 0
            ? engineResult.classification.warnings
            : ['No financial data found by the claude engine'],
          fromCache: false,
          status: 'validating',
          steps: [...steps, step('extract', 'Claude engine found no financial statements in the document')],
        };
      }

      const { classification, rawText: engineRawText, repairUsed } = engineResult;
      steps.push(
        step(
          'extract',
          `Claude engine extracted ${classification.statements.length} statement type(s)` +
            (repairUsed ? ' (repair pass used)' : ''),
          `tokens in/out: ${engineResult.usage.inputTokens}/${engineResult.usage.outputTokens}`,
        ),
      );

      cacheResult({
        rawText: engineRawText,
        extractionSource: 'claude',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
      });

      return {
        rawText: engineRawText,
        extractionSource: 'claude',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
        fromCache: false,
        status: 'validating',
        steps,
      };
    }

    // ── Excel Path ─────────────────────────────────────────────
    if (fileType === 'excel' || isExcelFile(null, fileName)) {
      steps.push(step('extract', 'Detected Excel file — parsing with xlsx'));
      const excelText = extractTextFromExcel(fileBuffer);

      if (!excelText || excelText.trim().length < 50) {
        return {
          status: 'failed',
          error: 'Excel file appears empty or has no readable financial data',
          steps: [...steps, step('extract', 'Failed: Excel file has no readable data')],
        };
      }

      steps.push(step('extract', `Extracted ${excelText.length} chars from Excel, classifying with AI`));
      const classification = await classifyFinancials(excelText);

      if (!classification || classification.statements.length === 0) {
        return {
          rawText: excelText,
          extractionSource: 'gpt4o',
          classification,
          statements: [],
          overallConfidence: 0,
          warnings: classification?.warnings ?? ['No financial data found in Excel file'],
          status: 'validating',
          steps: [...steps, step('extract', 'No financial statements found in Excel')],
        };
      }

      const stmtTypes = classification.statements.map(s => s.statementType).join(', ');
      const totalPeriods = classification.statements.reduce((sum, s) => sum + s.periods.length, 0);
      steps.push(step('extract', `Found: ${stmtTypes} (${totalPeriods} periods, confidence ${classification.overallConfidence}%)`));

      cacheResult({
        rawText: excelText,
        extractionSource: 'gpt4o',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
      });

      return {
        rawText: excelText,
        extractionSource: 'gpt4o',
        classification,
        statements: classification.statements,
        overallConfidence: classification.overallConfidence,
        warnings: classification.warnings,
        fromCache: false,
        status: 'validating',
        steps,
      };
    }

    // ── PDF Paths ──────────────────────────────────────────────

    // Layer 1: LlamaParse (structured markdown extraction)
    if (isLlamaParseEnabled()) {
      steps.push(step('extract', 'Trying LlamaParse (Layer 1) — structured markdown extraction'));
      try {
        const llamaResult = await parseWithLlama(fileBuffer, fileName || 'document.pdf');
        if (llamaResult && llamaResult.text.trim().length > MIN_TEXT_LENGTH) {
          steps.push(step('extract', `LlamaParse extracted ${llamaResult.text.length} chars from ${llamaResult.pages} pages`));

          // Use the clean markdown text for classification
          let llamaClassification: ClassificationResult | null = null;

          if (llamaResult.text.length > CHUNK_THRESHOLD) {
            const chunks = chunkDocument(llamaResult.text, MAX_CHUNK_SIZE);
            steps.push(step('extract', `LlamaParse text split into ${chunks.length} chunks`));
            const chunkResults = await Promise.all(
              chunks.slice(0, MAX_CHUNKS).map(async (chunk, i) => {
                try {
                  return await classifyFinancials(chunk.text);
                } catch (err) {
                  steps.push(step('extract', `LlamaParse chunk ${i + 1} failed`, String(err)));
                  return null;
                }
              })
            );
            const validResults = chunkResults.filter((r): r is ClassificationResult => r !== null);
            if (validResults.length > 0) {
              llamaClassification = mergeExtractionResults(validResults);
            }
          } else {
            llamaClassification = await classifyFinancials(llamaResult.text);
          }

          if (llamaClassification && llamaClassification.statements.length > 0) {
            const stmtTypes = llamaClassification.statements.map(s => s.statementType).join(', ');
            const totalPeriods = llamaClassification.statements.reduce((sum, s) => sum + s.periods.length, 0);
            steps.push(step('extract', `Found: ${stmtTypes} (${totalPeriods} periods, confidence ${llamaClassification.overallConfidence}%)`));

            cacheResult({
              rawText: llamaResult.text,
              extractionSource: 'gpt4o',
              classification: llamaClassification,
              statements: llamaClassification.statements,
              overallConfidence: llamaClassification.overallConfidence,
              warnings: llamaClassification.warnings,
            });

            return {
              rawText: llamaResult.text,
              extractionSource: 'gpt4o',
              classification: llamaClassification,
              statements: llamaClassification.statements,
              overallConfidence: llamaClassification.overallConfidence,
              warnings: llamaClassification.warnings,
              fromCache: false,
              status: 'validating',
              steps,
            };
          }
          steps.push(step('extract', 'LlamaParse returned text but no financials found — falling through to pdf-parse'));
        } else {
          steps.push(step('extract', 'LlamaParse returned no useful text — falling through'));
        }
      } catch (err) {
        steps.push(step('extract', 'LlamaParse failed — falling through to pdf-parse', String(err)));
      }
    }

    // Layer 2: pdf-parse text → AI classifier
    steps.push(step('extract', 'Extracting text with pdf-parse (Layer 2)'));
    let pdfText: string | null = null;
    let textClassification: ClassificationResult | null = null;
    try {
      const parsed = await pdfParse(fileBuffer);
      pdfText = parsed.text || null;
    } catch (err) {
      steps.push(step('extract', 'pdf-parse failed', String(err)));
    }

    if (pdfText && pdfText.trim().length >= MIN_TEXT_LENGTH) {
      steps.push(step('extract', `Extracted ${pdfText.length} chars — classifying with AI`));

      if (pdfText.length > CHUNK_THRESHOLD) {
        const chunks = chunkDocument(pdfText, MAX_CHUNK_SIZE);
        steps.push(step('extract', `Document is ${pdfText.length} chars — split into ${chunks.length} chunks`));

        const chunkResults = await Promise.all(
          chunks.slice(0, MAX_CHUNKS).map(async (chunk, i) => {
            try {
              steps.push(step('extract', `Extracting from chunk ${i + 1}/${Math.min(chunks.length, MAX_CHUNKS)} (relevance: ${chunk.relevanceScore})`));
              return await classifyFinancials(chunk.text);
            } catch (err) {
              steps.push(step('extract', `Chunk ${i + 1} extraction failed`, String(err)));
              return null;
            }
          })
        );

        const validResults = chunkResults.filter((r): r is ClassificationResult => r !== null);
        if (validResults.length > 0) {
          textClassification = mergeExtractionResults(validResults);
          steps.push(step('extract', `Merged ${validResults.length} chunk results`));
        }
      } else {
        textClassification = await classifyFinancials(pdfText);
      }

      const classification = textClassification;

      if (classification && classification.statements.length > 0) {
        const stmtTypes = classification.statements.map(s => s.statementType).join(', ');
        const totalPeriods = classification.statements.reduce((sum, s) => sum + s.periods.length, 0);
        steps.push(step('extract', `Found: ${stmtTypes} (${totalPeriods} periods, confidence ${classification.overallConfidence}%)`));

        cacheResult({
          rawText: pdfText,
          extractionSource: 'gpt4o',
          classification,
          statements: classification.statements,
          overallConfidence: classification.overallConfidence,
          warnings: classification.warnings,
        });

        return {
          rawText: pdfText,
          extractionSource: 'gpt4o',
          classification,
          statements: classification.statements,
          overallConfidence: classification.overallConfidence,
          warnings: classification.warnings,
          fromCache: false,
          status: 'validating',
          steps,
        };
      }

      steps.push(step('extract', 'Text extracted but no financial statements found — trying Vision'));
    } else {
      steps.push(step('extract', `Text too sparse (${pdfText?.trim().length ?? 0} chars) — trying Vision`));
    }

    // Layer 3: AI Vision (scanned / image-only PDFs)
    steps.push(step('extract', 'Switching to AI Vision (Layer 3)'));
    const visionClassification = await classifyFinancialsVision(
      fileBuffer,
      fileName || 'document.pdf',
      textClassification?.statements?.[0]?.currency,
    );

    if (!visionClassification || visionClassification.statements.length === 0) {
      return {
        rawText: pdfText ?? '',
        extractionSource: 'vision',
        classification: visionClassification,
        statements: [],
        overallConfidence: 0,
        warnings: visionClassification?.warnings ?? ['Could not extract financial data — document may be encrypted or unsupported'],
        status: 'validating',
        steps: [...steps, step('extract', 'Vision extraction found no financial statements')],
      };
    }

    const stmtTypes = visionClassification.statements.map(s => s.statementType).join(', ');
    const totalPeriods = visionClassification.statements.reduce((sum, s) => sum + s.periods.length, 0);
    steps.push(step('extract', `Vision found: ${stmtTypes} (${totalPeriods} periods, confidence ${visionClassification.overallConfidence}%)`));

    cacheResult({
      rawText: '',
      extractionSource: 'vision',
      classification: visionClassification,
      statements: visionClassification.statements,
      overallConfidence: visionClassification.overallConfidence,
      warnings: visionClassification.warnings,
    });

    return {
      rawText: '',
      extractionSource: 'vision',
      classification: visionClassification,
      statements: visionClassification.statements,
      overallConfidence: visionClassification.overallConfidence,
      warnings: visionClassification.warnings,
      fromCache: false,
      status: 'validating',
      steps,
    };
  } catch (err) {
    log.error('Extract node: unexpected error', err);
    captureAgentError(err, { agent: 'financialAgent', node: 'extract' });
    return {
      status: 'failed',
      error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      steps: [...steps, step('extract', 'Unexpected error', String(err))],
    };
  }
}

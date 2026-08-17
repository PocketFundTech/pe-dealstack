/**
 * Claude structured-output extraction engine (Phase 1, spec 2026-07-11).
 *
 * One extraction call per document (native PDF via Files API, or Excel text),
 * strict JSON schema output, deterministic normalization, then AT MOST ONE
 * repair call driven by the existing validateStatements() checks. Replaces
 * the legacy 4-layer fallback + verify/cross-verify/self-correct scaffold
 * when EXTRACTION_ENGINE=claude.
 */

import { toFile } from '@anthropic-ai/sdk';
import { log } from '../../utils/logger.js';
import { validateStatements } from '../financialValidator.js';
import type { ClassificationResult } from '../financialClassifier.js';
import { extractTextFromExcel } from '../excelFinancialExtractor.js';
import { trackedClaudeMessage, getAnthropicClient, AIRefusalError } from '../ai/client.js';
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_USER_INSTRUCTION,
  EXCEL_CONTAINER_INSTRUCTION,
  buildRepairInstruction,
  extractionResponseZod,
} from './extractionSchema.js';
import { toClassificationResult } from './normalize.js';

const FILES_BETA = 'files-api-2025-04-14';
// GA server tool (no beta header required) — supported by both extraction
// models (fable-5 primary, opus-4-8 fallback). The 20260120+ versions add
// programmatic tool calling / REPL persistence we don't need for a
// single-file read.
const CODE_EXECUTION_TOOL = { type: 'code_execution_20250825', name: 'code_execution' } as const;

/**
 * Container mode (default): spreadsheets are attached to a code-execution
 * container and the model reads the ACTUAL cells with pandas/openpyxl,
 * instead of extracting from a locally-flattened text dump. Flattening is
 * what capped legacy spreadsheet accuracy (~25%): merged cells, unit-scale
 * header rows, pivoted layouts and multi-table sheets all lose structure as
 * text. `EXCEL_EXTRACTION_MODE=text` is the env kill-switch back to
 * flattened-text extraction.
 */
function excelContainerModeEnabled(): boolean {
  return (process.env.EXCEL_EXTRACTION_MODE || 'container') !== 'text';
}

function spreadsheetMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

/**
 * Prefix on `rawText` for the PDF path — signals "no real text layer exists"
 * to any downstream confidence-scoring logic (see storeNode.ts's
 * computeSourceMatchAvg, which imports this constant rather than
 * hardcoding its own copy).
 */
export const CLAUDE_NATIVE_PDF_MARKER = '[claude-native-pdf]';

export interface ClaudeEngineInput {
  fileBuffer: Buffer;
  fileName: string;
  fileType: 'pdf' | 'excel' | 'image';
}

export interface ClaudeEngineResult {
  classification: ClassificationResult;
  /** Placeholder text for cache/UI parity — native PDF path has no text layer dump. */
  rawText: string;
  repairUsed: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

type ContentBlock = Record<string, unknown>;

function parseAndNormalize(text: string): ClassificationResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    log.error('claudeEngine: response was not valid JSON');
    return null;
  }
  const checked = extractionResponseZod.safeParse(parsed);
  if (!checked.success) {
    log.error('claudeEngine: response failed schema validation', {
      issues: checked.error.issues.slice(0, 5),
    });
    return null;
  }
  return toClassificationResult(checked.data);
}

function failureSummaries(classification: ClassificationResult): string[] {
  const validation = validateStatements(classification.statements);
  return validation.checks
    .filter((c) => !c.passed && c.severity === 'error')
    .map((c) => `${c.check}${c.period ? ` [${c.period}]` : ''}: ${c.message}`);
}

/** Which statement types (by statementType key) have at least one error-severity validation failure. */
function statementTypesWithErrors(statements: ClassificationResult['statements']): Set<string> {
  const types = new Set<string>();
  for (const stmt of statements) {
    const result = validateStatements([stmt]);
    if (result.errorCount > 0) types.add(stmt.statementType);
  }
  return types;
}

/**
 * Merge the repair response into the original extraction, statement-type by
 * statement-type. A statement type that was already clean in `first` is
 * NEVER replaced by the repair pass's version, even if present there — this
 * is the guard against a repair pass silently dropping or drifting a
 * correct statement type while fixing an unrelated one (see review finding:
 * a repaired response that omits a previously-clean statement type must not
 * be able to delete that data).
 */
function mergeRepairedStatements(
  first: ClassificationResult,
  repaired: ClassificationResult,
  failedTypes: Set<string>,
): ClassificationResult {
  const repairedByType = new Map(repaired.statements.map((s) => [s.statementType, s]));
  const statements = first.statements.map((stmt) => {
    if (!failedTypes.has(stmt.statementType)) return stmt; // clean — never touched by repair
    const repairedStmt = repairedByType.get(stmt.statementType);
    if (!repairedStmt) return stmt; // repair dropped the whole type → keep original

    // Guard against the repair pass silently DELETING a period that was
    // present in `first` — the same count-based acceptance gate that
    // motivated the type-level guard above would read a shrunk period list
    // as "improvement" (fewer periods → fewer checks → fewer failures).
    // Any period present in `first` but missing from `repaired` is carried
    // forward verbatim; periods the repair pass DID return are trusted (it
    // was asked to fix specific periods, and mixing values across passes
    // for a period it touched would be worse than trusting its output).
    const repairedPeriodNames = new Set(repairedStmt.periods.map((p) => p.period));
    const droppedPeriods = stmt.periods.filter((p) => !repairedPeriodNames.has(p.period));
    return droppedPeriods.length > 0
      ? { ...repairedStmt, periods: [...repairedStmt.periods, ...droppedPeriods] }
      : repairedStmt;
  });
  return {
    statements,
    // Deliberately conservative: min(), not average — this is an integrity
    // gate (storeNode.ts blocks storage below a confidence threshold), and
    // understating confidence after a partial repair is the safe direction
    // to be wrong in. Do not "improve" this to an average.
    overallConfidence: Math.min(first.overallConfidence, repaired.overallConfidence),
    warnings: [...first.warnings, ...repaired.warnings],
  };
}

export async function extractWithClaude(input: ClaudeEngineInput): Promise<ClaudeEngineResult | null> {
  // Container-first for spreadsheets, with an automatic fallback ladder so
  // accuracy can only go up: container mode → flattened-text mode → (caller
  // falls back to the legacy chain on null). Any container failure — upload
  // error, tool rejection, refusal, unparseable output — degrades to today's
  // behavior instead of failing the extraction outright.
  if (input.fileType === 'excel' && excelContainerModeEnabled()) {
    try {
      const containerResult = await runExtraction(input, 'container');
      if (containerResult) return containerResult;
      log.warn('claudeEngine: container-mode spreadsheet extraction returned nothing — falling back to text mode', {
        fileName: input.fileName,
      });
    } catch (err) {
      log.warn('claudeEngine: container-mode spreadsheet extraction failed — falling back to text mode', {
        fileName: input.fileName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return runExtraction(input, 'standard');
}

async function runExtraction(
  input: ClaudeEngineInput,
  mode: 'standard' | 'container',
): Promise<ClaudeEngineResult | null> {
  const { fileBuffer, fileName, fileType } = input;
  const usage = { inputTokens: 0, outputTokens: 0 };

  // ── Build the document content block ─────────────────────────────
  let documentBlocks: ContentBlock[];
  let rawText: string;
  // Tracks the Files API upload (PDF and container-spreadsheet branches) so
  // it can be deleted in the `finally` below regardless of how the
  // extraction below exits — the Files API has no TTL/auto-expiry, so an
  // undeleted file is a permanent leak against the org's storage cap.
  let uploadedFileId: string | null = null;
  let extraBetas: string[];
  let tools: unknown[] | undefined;
  let baseInstruction: string = EXTRACTION_USER_INSTRUCTION;

  if (fileType === 'excel' && mode === 'container') {
    // rawText parity for cache/UI still comes from the local flattening
    // (cheap); when the local parser can't read the workbook at all, keep
    // going — reading files the flattener chokes on is exactly what the
    // container path is for. The no-text-layer marker keeps storeNode's
    // source-match confidence scoring from penalizing unmatched quotes
    // (same convention as the native-PDF path).
    const excelText = extractTextFromExcel(fileBuffer);
    rawText = excelText && excelText.trim().length >= 50
      ? excelText
      : `${CLAUDE_NATIVE_PDF_MARKER} ${fileName} — spreadsheet read natively in code-execution container; no local text conversion`;
    const client = getAnthropicClient();
    let uploaded: { id: string };
    try {
      uploaded = (await client.beta.files.upload({
        file: await toFile(fileBuffer, fileName, { type: spreadsheetMime(fileName) }),
        betas: [FILES_BETA],
      } as never)) as { id: string };
    } catch (err) {
      log.error('claudeEngine: spreadsheet upload failed', err, { fileName });
      return null;
    }
    uploadedFileId = uploaded.id;
    documentBlocks = [{ type: 'container_upload', file_id: uploaded.id }];
    extraBetas = [FILES_BETA];
    tools = [CODE_EXECUTION_TOOL];
    baseInstruction = EXCEL_CONTAINER_INSTRUCTION;
  } else if (fileType === 'excel') {
    const excelText = extractTextFromExcel(fileBuffer);
    if (!excelText || excelText.trim().length < 50) {
      log.warn('claudeEngine: excel file has no readable data', { fileName });
      return null;
    }
    rawText = excelText;
    documentBlocks = [{ type: 'text', text: `Document (${fileName}, converted from Excel):\n\n${excelText}` }];
    extraBetas = [];
  } else {
    // PDF (and image-PDF) path: upload once, reference by file_id.
    const client = getAnthropicClient();
    let uploaded: { id: string };
    try {
      uploaded = (await client.beta.files.upload({
        file: await toFile(fileBuffer, fileName, { type: 'application/pdf' }),
        betas: [FILES_BETA],
      } as never)) as { id: string };
    } catch (err) {
      log.error('claudeEngine: file upload failed', err, { fileName });
      return null;
    }
    uploadedFileId = uploaded.id;
    rawText = `${CLAUDE_NATIVE_PDF_MARKER} ${fileName} — extracted via structured output; no text-layer dump`;
    documentBlocks = [
      { type: 'document', source: { type: 'file', file_id: uploaded.id } },
    ];
    extraBetas = [FILES_BETA];
  }

  const callEngine = async (extraInstruction?: string): Promise<ClassificationResult | null> => {
    try {
      const res = await trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        system: EXTRACTION_SYSTEM_PROMPT,
        extraBetas,
        ...(tools ? { tools } : {}),
        messages: [
          {
            role: 'user',
            content: [
              ...documentBlocks,
              { type: 'text', text: extraInstruction ?? baseInstruction },
            ],
          },
        ],
        outputSchema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
      });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      return parseAndNormalize(res.text);
    } catch (err) {
      if (err instanceof AIRefusalError) {
        // Survived the server-side fallback chain — content outcome, not a bug.
        log.warn('claudeEngine: extraction refused by safety classifiers', {
          fileName,
          category: err.category,
        });
        return null;
      }
      throw err;
    }
  };

  try {
    // ── Pass 1: extraction ────────────────────────────────────────────
    const first = await callEngine();
    if (!first || first.statements.length === 0) {
      return first ? { classification: first, rawText, repairUsed: false, usage } : null;
    }

    // ── Pass 2 (max one): repair only if deterministic checks fail ────
    const firstFailures = failureSummaries(first);
    if (firstFailures.length === 0) {
      return { classification: first, rawText, repairUsed: false, usage };
    }

    const failedTypes = statementTypesWithErrors(first.statements);
    log.info('claudeEngine: validator failures — running single repair pass', {
      fileName,
      failures: firstFailures.length,
      failedStatementTypes: [...failedTypes],
    });
    const previousJson = JSON.stringify(first.statements);
    const repaired = await callEngine(buildRepairInstruction(firstFailures, previousJson));

    if (repaired && repaired.statements.length > 0) {
      const merged = mergeRepairedStatements(first, repaired, failedTypes);
      const mergedFailures = failureSummaries(merged);
      if (mergedFailures.length < firstFailures.length) {
        merged.warnings.push(
          `Repair pass fixed ${firstFailures.length - mergedFailures.length}/${firstFailures.length} validation errors`,
        );
        return { classification: merged, rawText, repairUsed: true, usage };
      }
    }

    first.warnings.push('Repair pass did not improve validation — original extraction kept');
    return { classification: first, rawText, repairUsed: true, usage };
  } finally {
    if (uploadedFileId) {
      const fileIdToDelete = uploadedFileId;
      void getAnthropicClient()
        .beta.files.delete(fileIdToDelete, { betas: [FILES_BETA] } as never)
        .catch((err: unknown) => log.warn('claudeEngine: failed to delete uploaded file', { fileName, fileId: fileIdToDelete, err }));
    }
  }
}

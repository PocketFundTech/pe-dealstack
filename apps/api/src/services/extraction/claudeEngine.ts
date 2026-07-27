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
  buildRepairInstruction,
  extractionResponseZod,
} from './extractionSchema.js';
import { toClassificationResult } from './normalize.js';

const FILES_BETA = 'files-api-2025-04-14';

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
    return repairedByType.get(stmt.statementType) ?? stmt; // repair dropped it → keep original
  });
  return {
    statements,
    overallConfidence: Math.min(first.overallConfidence, repaired.overallConfidence),
    warnings: [...first.warnings, ...repaired.warnings],
  };
}

export async function extractWithClaude(input: ClaudeEngineInput): Promise<ClaudeEngineResult | null> {
  const { fileBuffer, fileName, fileType } = input;
  const usage = { inputTokens: 0, outputTokens: 0 };

  // ── Build the document content block ─────────────────────────────
  let documentBlocks: ContentBlock[];
  let rawText: string;
  // Tracks the Files API upload (PDF branch only) so it can be deleted in the
  // `finally` below regardless of how the extraction below exits — the Files
  // API has no TTL/auto-expiry, so an undeleted file is a permanent leak
  // against the org's storage cap.
  let uploadedFileId: string | null = null;

  if (fileType === 'excel') {
    const excelText = extractTextFromExcel(fileBuffer);
    if (!excelText || excelText.trim().length < 50) {
      log.warn('claudeEngine: excel file has no readable data', { fileName });
      return null;
    }
    rawText = excelText;
    documentBlocks = [{ type: 'text', text: `Document (${fileName}, converted from Excel):\n\n${excelText}` }];
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
    rawText = `[claude-native-pdf] ${fileName} — extracted via structured output; no text-layer dump`;
    documentBlocks = [
      { type: 'document', source: { type: 'file', file_id: uploaded.id } },
    ];
  }

  const callEngine = async (extraInstruction?: string): Promise<ClassificationResult | null> => {
    try {
      const res = await trackedClaudeMessage({
        operation: 'financial_extraction',
        role: 'extraction',
        system: EXTRACTION_SYSTEM_PROMPT,
        extraBetas: fileType === 'excel' ? [] : [FILES_BETA],
        messages: [
          {
            role: 'user',
            content: [
              ...documentBlocks,
              { type: 'text', text: extraInstruction ?? EXTRACTION_USER_INSTRUCTION },
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

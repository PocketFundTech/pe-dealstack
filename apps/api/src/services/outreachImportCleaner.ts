// ─── Import row cleaning — Claude port of the team's manual "cleaning
//     skill" ──────────────────────────────────────────────────────────
//
// Private Circle's CSV export (services/outreachPrivateCircleImport.ts)
// arrives with raw, inconsistent company names ("ACME TECHNOLOGIES
// PVT.LTD.", "acme technologies pvt ltd") and a single free-text
// decision-maker name column ("Priya Sharma", "SHARMA, PRIYA", "Mr. Priya
// Sharma (VP Ops)"). Per this feature's source planning doc, a human on
// the team today does this by hand with a Claude "cleaning skill" prompt
// before retyping rows into Reply.io — this module is that step, ported
// into the automated import path.
//
// This is NOT the same job as outreachContactImport.ts's
// normalizeCompanyName() — that's a deterministic, lowercase/suffix-
// stripped string used ONLY internally for de-dupe matching, never stored
// or shown to a human. This module produces the actual canonical `company`
// field that gets persisted and displayed on the board (proper casing,
// suffix cleanup, whitespace normalization), plus a best-effort first/last
// split of the raw contact-name column (handles stray honorifics, trailing
// job titles in parens, "Last, First" ordering, double spacing, etc.) that
// gets recombined into a clean full name before it reaches the import
// engine. The two normalizations solve different problems and both run —
// this one first, then the engine's deterministic one on top for matching.
//
// ─── Calling convention ────────────────────────────────────────────────
// Same idiom as services/replyIntentClassifier.ts: ChatAnthropic via
// getChatAnthropicAuthFields() (works whether the org has
// ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN set), structured output via
// `.withStructuredOutput()`. Soft-fail throughout, per this feature area's
// established convention: no Claude credentials, or a batch call failing,
// never blocks the import — the caller falls back to the raw
// (deterministically-normalized-for-matching-only) values for whatever
// didn't get cleaned.
//
// ─── Batching ───────────────────────────────────────────────────────────
// One Claude call per row would be wasteful and slow for a ~100-200 row
// Private Circle export. One call for the whole export risks an
// unnecessarily large single output and a single point of failure. Rows
// are chunked into fixed-size batches (IMPORT_CLEAN_BATCH_SIZE) and cleaned
// with one structured-output call per batch, run concurrently — for a
// 200-row export that's ~5 small concurrent calls, not 200 or 1. Each
// row's cleaned result is matched back to its input by `index`, so a
// batch that comes back short (or fails entirely) only loses cleaning for
// its own rows, never corrupts another batch's mapping.

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { hasAnthropicCredentials, getChatAnthropicAuthFields } from './anthropic.js';

// ─── Config ──────────────────────────────────────────────────────────

/** Sonnet 4.6 — exact model ID per Anthropic SDK spec, matching
 *  replyIntentClassifier.ts. Do not append a date suffix. */
const SONNET_MODEL = 'claude-sonnet-4-6';

/** Rows per Claude call. Small enough that one call's output (~30-40 tokens
 *  per cleaned row) comfortably fits well inside MAX_OUTPUT_TOKENS even at
 *  the top of the range, large enough that a ~100-200 row Private Circle
 *  export only needs a handful of calls, not one per row. */
const IMPORT_CLEAN_BATCH_SIZE = 40;

/** Hard ceiling on total rows this module will ever attempt to clean in one
 *  call to cleanImportRows — well above Private Circle's ~100-200 row CSV
 *  export cap, but bounded rather than unbounded: rows beyond this are left
 *  uncleaned (caller falls back to the raw value) rather than fanning out
 *  an unbounded number of concurrent Claude calls. */
const MAX_ROWS_PER_CLEAN_CALL = 500;

const MAX_OUTPUT_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 60_000;

let cachedModel: ChatAnthropic | null = null;

function getModel(): ChatAnthropic | null {
  if (cachedModel) return cachedModel;
  const authFields = getChatAnthropicAuthFields();
  if (!authFields) return null;
  cachedModel = new ChatAnthropic({
    model: SONNET_MODEL,
    ...authFields,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return cachedModel;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface RawImportNameFields {
  /** Position in the caller's row array — the only join key back to the original row. */
  index: number;
  companyName: string;
  /** Single free-text decision-maker name column, if the source has one. */
  contactName?: string | null;
}

export interface CleanedImportNameFields {
  index: number;
  /** Canonical, human-readable company name — null only when the input was too garbled to confidently clean. */
  company: string | null;
  firstName: string | null;
  lastName: string | null;
}

const cleanedRowSchema = z.object({
  index: z.number().int().describe('Echo back the exact index from the input row this result corresponds to.'),
  company: z
    .string()
    .trim()
    .nullable()
    .describe(
      'The company name cleaned to a canonical, human-readable form: strip legal-entity suffixes ' +
        '(Pvt Ltd, Private Limited, Ltd, LLP, Inc, Corp, Co, and similar), fix ALL-CAPS or all-lowercase ' +
        'input to normal title case (but preserve short all-caps acronyms that are clearly part of the ' +
        'brand name, e.g. "TCS", "HDFC"), and collapse extra whitespace/punctuation. Never fabricate a ' +
        'name that is not derivable from the input — return null only if the input is empty or too ' +
        'garbled to confidently clean.',
    ),
  firstName: z
    .string()
    .trim()
    .nullable()
    .describe(
      'First name split out of the raw contact-name column, if one was provided. Strip honorifics ' +
        '(Mr./Mrs./Ms./Dr.) and trailing parenthetical job titles. Handle "Last, First" ordering. Null if ' +
        'no contact name was provided or nothing usable could be split out.',
    ),
  lastName: z
    .string()
    .trim()
    .nullable()
    .describe('Last name split out the same way as firstName. Null if the input was a single word or empty.'),
});

const cleanBatchSchema = z.object({
  rows: z.array(cleanedRowSchema),
});

// ─── Public API ──────────────────────────────────────────────────────

/**
 * True when Claude is reachable (ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN
 * set). Callers should check this before building the input array at all,
 * mirroring isReplyIntentClassifierEnabled() in replyIntentClassifier.ts.
 */
export function isImportCleanerEnabled(): boolean {
  return hasAnthropicCredentials();
}

async function cleanOneBatch(batch: RawImportNameFields[]): Promise<Map<number, CleanedImportNameFields>> {
  const results = new Map<number, CleanedImportNameFields>();
  const model = getModel();
  if (!model) return results;

  const inputLines = batch.map((r) => ({
    index: r.index,
    companyName: r.companyName,
    contactName: r.contactName || null,
  }));

  const prompt = [
    'Clean the following rows exported from a company-sourcing tool, ahead of importing them into an',
    'outreach CRM. For EACH row, return a cleaned company name and (if a contact name was given) a',
    'first/last name split. Return exactly one result per input row, each carrying the same `index` so',
    'results can be matched back to their input row. Never invent information that is not present in the',
    'input — when in doubt, pass a field through with only whitespace/casing cleanup rather than guessing',
    'at a fuller name.',
    '',
    'INPUT ROWS (JSON):',
    JSON.stringify(inputLines),
  ].join('\n');

  try {
    const structured = await model
      .withStructuredOutput(cleanBatchSchema, {
        method: 'functionCalling',
        name: 'clean_import_rows',
      })
      .invoke(
        [
          new SystemMessage(
            'You clean messy company/contact-name data exported from a sourcing tool, ahead of an import ' +
              'into a private-equity outreach CRM. You only reformat/normalize what is already present in ' +
              'the input — you never fabricate company or person names. Return valid structured output only.',
          ),
          new HumanMessage(prompt),
        ],
        { runName: 'outreachImportCleaner', tags: ['outreach', 'import-cleaning'] },
      );

    const parsed = cleanBatchSchema.parse(structured);
    for (const row of parsed.rows) {
      results.set(row.index, { index: row.index, company: row.company, firstName: row.firstName, lastName: row.lastName });
    }
    return results;
  } catch (err) {
    // SDK typed exceptions per shared/error-codes.md — most-specific first,
    // same handling as replyIntentClassifier.ts.
    if (err instanceof Anthropic.RateLimitError) {
      log.warn('outreachImportCleaner: rate limited, batch left uncleaned', { batchSize: batch.length });
    } else if (err instanceof Anthropic.AuthenticationError) {
      log.warn('outreachImportCleaner: authentication failed — check ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN');
    } else if (err instanceof Anthropic.APIError) {
      log.warn('outreachImportCleaner: API error, batch left uncleaned', { status: err.status, message: err.message });
    } else {
      log.warn('outreachImportCleaner: batch cleaning failed', { error: err instanceof Error ? err.message : String(err) });
    }
    // Never throws past itself — a failed batch just leaves its rows
    // unmatched in the returned map; the caller falls back to raw values.
    return results;
  }
}

/**
 * Cleans company/contact-name fields for a batch of import rows via Claude,
 * chunked into IMPORT_CLEAN_BATCH_SIZE-sized calls run concurrently.
 * Returns a Map keyed by each input row's `index` — entries are only
 * present for rows a Claude call actually returned a result for, so
 * callers should treat a missing index as "not cleaned, use the raw
 * value" rather than an error. Returns an empty Map (never throws, never
 * null) when Claude isn't configured or every batch failed — same
 * soft-fail contract as the rest of this feature area.
 */
export async function cleanImportRows(rows: RawImportNameFields[]): Promise<Map<number, CleanedImportNameFields>> {
  if (!hasAnthropicCredentials()) {
    log.info('outreachImportCleaner: skipped — ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not set');
    return new Map();
  }
  if (rows.length === 0) return new Map();

  const bounded = rows.slice(0, MAX_ROWS_PER_CLEAN_CALL);
  if (bounded.length < rows.length) {
    log.warn('outreachImportCleaner: row count exceeds MAX_ROWS_PER_CLEAN_CALL, extra rows left uncleaned', {
      totalRows: rows.length,
      cleanedRows: bounded.length,
    });
  }

  const batches: RawImportNameFields[][] = [];
  for (let i = 0; i < bounded.length; i += IMPORT_CLEAN_BATCH_SIZE) {
    batches.push(bounded.slice(i, i + IMPORT_CLEAN_BATCH_SIZE));
  }

  const batchResults = await Promise.all(batches.map((batch) => cleanOneBatch(batch)));

  const merged = new Map<number, CleanedImportNameFields>();
  for (const batchMap of batchResults) {
    for (const [index, cleaned] of batchMap) merged.set(index, cleaned);
  }

  log.info('outreachImportCleaner: cleaning complete', {
    totalRows: rows.length,
    attempted: bounded.length,
    cleaned: merged.size,
    batches: batches.length,
  });

  return merged;
}

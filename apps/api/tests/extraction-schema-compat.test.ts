/**
 * PROD REGRESSION (2026-08-18): DEAL_READ_JSON_SCHEMA used
 * `minimum: 0, maximum: 100` on number fields. The structured-output
 * (output_config.format) schema validator rejects those keywords —
 * "For 'number' type, properties maximum, minimum are not supported" —
 * which 400'd EVERY INGEST_ENGINE=claude deal read in production (the
 * fallback ladder then hit a legacy chain with exhausted OpenAI credits,
 * turning a silent degradation into a full ingest outage).
 *
 * This test recursively scans every structured-output schema this codebase
 * sends for the constraint keywords that validator rejects, so the class
 * of bug is caught at test time, not by the first production upload.
 * (Sibling of deal-chat-tool-schemas.test.ts, which does the same for
 * tool input_schema's `type: [...]` arrays.)
 */
import { describe, it, expect } from 'vitest';
import { DEAL_READ_JSON_SCHEMA } from '../src/services/extraction/claudeDealReader.js';
import { EXTRACTION_JSON_SCHEMA } from '../src/services/extraction/extractionSchema.js';

const REJECTED_NUMBER_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];

function findRejectedKeywords(node: unknown, path: string, hits: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => findRejectedKeywords(item, `${path}[${i}]`, hits));
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const kw of REJECTED_NUMBER_KEYWORDS) {
    if (kw in obj) hits.push(`${path}.${kw}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    findRejectedKeywords(value, `${path}.${key}`, hits);
  }
}

describe('structured-output schemas — no unsupported constraint keywords', () => {
  it.each([
    ['DEAL_READ_JSON_SCHEMA', DEAL_READ_JSON_SCHEMA],
    ['EXTRACTION_JSON_SCHEMA', EXTRACTION_JSON_SCHEMA],
  ])('%s contains no number-constraint keywords the API rejects', (name, schema) => {
    const hits: string[] = [];
    findRejectedKeywords(schema, name, hits);
    expect(hits, `unsupported constraint keywords (move ranges into descriptions): ${hits.join(', ')}`).toEqual([]);
  });
});

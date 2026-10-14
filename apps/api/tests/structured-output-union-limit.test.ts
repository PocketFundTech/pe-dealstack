// The Anthropic structured-output validator caps how many union-typed
// parameters (anyOf / nullable) a schema may contain. On 2026-10-13 the
// Claude deal reader's schema had 20 and was rejected on both Haiku and
// Sonnet 5 ("Schemas contains too many parameters with union types (20
// parameters …)"), so every INGEST_ENGINE=claude deal read failed and fell
// back to the legacy extractor. 14 was confirmed accepted on both models.
import { describe, it, expect } from 'vitest';
import { normalizeOutputSchema } from '../src/services/ai/schemaCompat.js';
import { DEAL_READ_JSON_SCHEMA } from '../src/services/extraction/claudeDealReader.js';
import { EXTRACTION_JSON_SCHEMA } from '../src/services/extraction/extractionSchema.js';
import { CONCENTRATION_JSON_SCHEMA } from '../src/services/analysis/customerConcentrationReader.js';
import { finalizeExtractedDealData } from '../src/services/aiExtractor.js';

const MAX_UNION_PARAMS = 14; // highest count confirmed accepted

function countUnions(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((n, x) => n + countUnions(x), 0);
  const obj = node as Record<string, unknown>;
  return (obj.anyOf ? 1 : 0) + Object.values(obj).reduce<number>((n, x) => n + countUnions(x), 0);
}

describe('structured-output schemas stay under the union-parameter limit', () => {
  it.each([
    ['deal reader', DEAL_READ_JSON_SCHEMA],
    ['Fable extraction', EXTRACTION_JSON_SCHEMA],
    ['customer concentration', CONCENTRATION_JSON_SCHEMA],
  ])('%s', (_name, schema) => {
    const normalized = normalizeOutputSchema(JSON.parse(JSON.stringify(schema)));
    expect(countUnions(normalized)).toBeLessThanOrEqual(MAX_UNION_PARAMS);
  });
});

describe('deal reader "no source" round-trip', () => {
  it('maps an empty source back to null', () => {
    const out = finalizeExtractedDealData(
      {
        companyName: { value: 'Acme', confidence: 90, source: '' },
        revenue: { value: 25.1, confidence: 80, source: 'FY24 revenue INR 251.3 crore' },
      },
      5000,
    );
    expect(out.companyName.source).toBeNull();
    expect(out.revenue.source).toBe('FY24 revenue INR 251.3 crore');
  });
});

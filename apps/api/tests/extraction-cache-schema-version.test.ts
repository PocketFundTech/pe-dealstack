/**
 * The Claude-engine extraction cache was keyed on (content hash, engine,
 * model) only. After the crore/lakh scale fix, re-extracting a document that
 * was already cached would replay the old, wrongly scaled statements for up
 * to 30 days. The cache tier now carries the extraction schema version.
 */
import { describe, it, expect } from 'vitest';
import { claudeExtractionCacheTier, EXTRACTION_SCHEMA_VERSION } from '../src/services/extraction/extractionSchema.js';

describe('claudeExtractionCacheTier', () => {
  it('includes the model and the extraction schema version', () => {
    expect(claudeExtractionCacheTier('claude-fable-5')).toBe(`claude-fable-5@${EXTRACTION_SCHEMA_VERSION}`);
  });

  it('is on a version newer than the one that shipped the lossy scale rules', () => {
    expect(EXTRACTION_SCHEMA_VERSION).not.toBe('v1');
  });
});

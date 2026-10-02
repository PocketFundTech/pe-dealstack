/** QA #12: extraction concurrency is configurable (default 4, clamped 1–8). */
import { describe, it, expect } from 'vitest';
import { extractionConcurrency } from '../src/services/agents/financialAgent/concurrency.js';

describe('extractionConcurrency', () => {
  it.each([[undefined, 4], ['', 4], ['abc', 4], ['2', 2], ['6', 6], ['0', 1], ['-3', 1], ['50', 8]])(
    'EXTRACTION_CONCURRENCY=%s → %s', (raw, expected) => {
      expect(extractionConcurrency(raw as string | undefined)).toBe(expected);
    });
});

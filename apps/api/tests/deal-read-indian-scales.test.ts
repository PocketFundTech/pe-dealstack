/**
 * Live QA 2026-10-01: an Excel P&L headed "(INR crore)" with FY2025 revenue
 * 251.3 put revenue 251.3 on the deal — read as ₹251.3M, so the headline
 * showed "₹25.1 Cr" instead of "₹251.3 Cr". Both deal-reading prompts only
 * described $-in-millions / $-in-thousands table headers; crore and lakh
 * were covered only as a suffix on a single number ("₹9 Crores").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('deal-reading prompts handle Indian table scales', () => {
  it('legacy extractor: a crore / lakh table header converts the whole table to millions', async () => {
    const { buildExtractionSystemPrompt } = await import('../src/services/aiExtractor.js');
    const prompt = buildExtractionSystemPrompt('2026-10-02');
    expect(prompt).toMatch(/\(INR crore\)/);
    expect(prompt).toMatch(/251\.3.*2513/);
    expect(prompt).toMatch(/lakh/i);
  });

  it('Claude deal reader: revenue, EBITDA and deal size all carry the crore / lakh rule', async () => {
    const { DEAL_READ_JSON_SCHEMA } = await import('../src/services/extraction/claudeDealReader.js');
    const props = (DEAL_READ_JSON_SCHEMA as any).properties;
    for (const field of ['revenue', 'ebitda', 'dealSize']) {
      const text = JSON.stringify(props[field]);
      expect(text, field).toMatch(/crore/i);
      expect(text, field).toMatch(/×\s?10|multiply by 10/i);
    }
  });
});

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

/** A minimal model reply in the deal reader's shape. */
const reply = (over: Record<string, unknown>) => ({
  companyName: { value: 'Northwind', confidence: 90, source: null },
  industry: { value: 'Logistics', confidence: 90, source: null },
  description: { value: 'Cold chain.', confidence: 90 },
  currency: 'INR',
  revenue: { value: 251.3, confidence: 90, source: 'Revenue 251.3' },
  ebitda: { value: 30.2, confidence: 90, source: 'EBITDA 30.2' },
  ebitdaMargin: { value: null, confidence: 0 },
  revenueGrowth: { value: null, confidence: 0, source: null },
  employees: { value: null, confidence: 0 },
  foundedYear: { value: null, confidence: 0 },
  headquarters: { value: null, confidence: 0 },
  dealSize: { value: null, confidence: 0, source: null },
  keyRisks: [], investmentHighlights: [], summary: 'x',
  ...over,
});

describe('deterministic unit check on the fast read (G16)', () => {
  it('corrects a crore figure the model failed to convert, and says so', async () => {
    const { finalizeExtractedDealData } = await import('../src/services/aiExtractor.js');
    const r = finalizeExtractedDealData(reply({ figuresUnit: 'CRORES', revenueAsPrinted: 251.3, ebitdaAsPrinted: 30.2 }), 50_000);
    expect(r.revenue.value).toBeCloseTo(2513, 6);
    expect(r.ebitda.value).toBeCloseTo(302, 6);
    expect(r.revenue.confidence).toBeLessThanOrEqual(60);
    expect(r.needsReview).toBe(true);
    expect(r.reviewReasons.join(' ')).toContain('251.3 in crores');
  });

  it('leaves a correctly converted figure alone', async () => {
    const { finalizeExtractedDealData } = await import('../src/services/aiExtractor.js');
    const r = finalizeExtractedDealData(reply({ revenue: { value: 2513, confidence: 90, source: null }, ebitda: { value: 302, confidence: 90, source: null },
      figuresUnit: 'CRORES', revenueAsPrinted: 251.3, ebitdaAsPrinted: 30.2 }), 50_000);
    expect(r.revenue.value).toBe(2513);
    expect(r.reviewReasons.join(' ')).not.toContain('crores');
  });

  it('skips the check when the model gave no printed figure (e.g. MRR annualised)', async () => {
    const { finalizeExtractedDealData } = await import('../src/services/aiExtractor.js');
    const r = finalizeExtractedDealData(reply({ figuresUnit: 'MILLIONS', revenueAsPrinted: null, ebitdaAsPrinted: null }), 50_000);
    expect(r.revenue.value).toBe(251.3);
  });

  it('asks the Claude deal reader for the printed figures and their unit', async () => {
    const { DEAL_READ_JSON_SCHEMA } = await import('../src/services/extraction/claudeDealReader.js');
    const schema = DEAL_READ_JSON_SCHEMA as any;
    for (const k of ['figuresUnit', 'revenueAsPrinted', 'ebitdaAsPrinted', 'dealSizeAsPrinted']) {
      expect(schema.properties[k], k).toBeDefined();
      expect(schema.required, k).toContain(k);
    }
  });
});

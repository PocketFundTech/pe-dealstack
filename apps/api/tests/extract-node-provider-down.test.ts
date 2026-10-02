/**
 * Fix plan G5: when the AI provider rejects the request (out of credit,
 * bad key, rate limit) the extraction fails WITH that reason. Before, the
 * per-sheet / per-chunk catches swallowed it and the run "completed" with
 * "No financial data found in Excel file".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIProviderUnavailableError } from '../src/utils/aiErrors.js';

const outOfCredit = () => new AIProviderUnavailableError('Anthropic', { reason: 'quota', detail: 'Your credit balance is too low' });

const extractWithClaude = vi.fn();
vi.mock('../src/services/extraction/claudeEngine.js', () => ({ extractWithClaude: (...a: unknown[]) => extractWithClaude(...a) }));

const classify = vi.fn();
vi.mock('../src/services/financialCrossVerify.js', () => ({ classifyFinancialsCrossVerified: (...a: unknown[]) => classify(...a) }));

vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  isExcelFile: () => true,
  extractSheetsFromExcel: () => [
    { name: 'P&L', score: 90, text: 'Income statement FY2024 revenue 27.3 EBITDA 2.2 '.repeat(4) },
    { name: 'Cash flow', score: 80, text: 'Cash flow FY2024 operating cash flow 2.0 capex 2.6 '.repeat(4) },
  ],
}));

vi.mock('../src/services/agents/financialAgent/extractionCache.js', () => ({
  hashContent: vi.fn(() => 'hash'),
  getCachedExtraction: vi.fn(async () => null),
  putCachedExtraction: vi.fn(async () => undefined),
}));

const savedEngine = process.env.EXTRACTION_ENGINE;
beforeEach(() => { extractWithClaude.mockReset(); classify.mockReset(); });
afterEach(() => {
  if (savedEngine === undefined) delete process.env.EXTRACTION_ENGINE;
  else process.env.EXTRACTION_ENGINE = savedEngine;
});

const run = async (fileType: 'excel' | 'pdf') => {
  const { extractNode } = await import('../src/services/agents/financialAgent/nodes/extractNode.js');
  return extractNode({ fileBuffer: Buffer.from('x'), fileName: `f.${fileType === 'excel' ? 'xlsx' : 'pdf'}`, fileType, forceExtraction: true } as any);
};

describe('extractNode — provider rejections', () => {
  it('Excel: every sheet rejected by the provider → failed with the reason, not "no financial data"', async () => {
    delete process.env.EXTRACTION_ENGINE;
    classify.mockRejectedValue(outOfCredit());
    const result = await run('excel');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('credits are exhausted');
    expect(result.warnings ?? []).not.toContain('No financial data found in Excel file');
  });

  it('Excel: a sheet that worked still wins over one the provider rejected', async () => {
    delete process.env.EXTRACTION_ENGINE;
    classify
      .mockResolvedValueOnce({
        statements: [{ statementType: 'INCOME_STATEMENT', unitScale: 'MILLIONS', currency: 'USD',
          periods: [{ period: '2024', periodType: 'HISTORICAL', confidence: 90, lineItems: { revenue: 27.3 } }] }],
        overallConfidence: 90, warnings: [],
      })
      .mockRejectedValueOnce(outOfCredit());
    const result = await run('excel');
    expect(result.status).toBe('validating');
    expect(result.statements).toHaveLength(1);
  });

  it('Claude engine: a provider rejection fails the run with the plain reason', async () => {
    process.env.EXTRACTION_ENGINE = 'claude';
    extractWithClaude.mockRejectedValue(outOfCredit());
    const result = await run('pdf');
    expect(result.status).toBe('failed');
    expect(result.error).toBe(outOfCredit().message);
  });
});

/**
 * validateNode must never claim a self-correction attempt for claude-sourced
 * state — the claude engine already ran its own repair pass inside extract,
 * and graph.ts's routeAfterValidate forces claude state straight to 'store'
 * regardless of what status validateNode sets. This pins the log message
 * and status to stay consistent with that, rather than relying solely on
 * the router to silently override a misleading status.
 */
import { describe, it, expect } from 'vitest';

async function getValidateNode() {
  const mod = await import('../src/services/agents/financialAgent/nodes/validateNode.js');
  return mod.validateNode;
}

function stateWithFailingBalanceSheet(extractionSource: string) {
  return {
    extractionSource,
    retryCount: 0,
    maxRetries: 3,
    overallConfidence: 80,
    statements: [
      {
        statementType: 'BALANCE_SHEET',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 90,
            lineItems: { cash: 20, total_assets: 100, total_liabilities: 50, total_equity: 30 }, // 50+30=80≠100
          },
        ],
      },
    ],
  } as any;
}

function stateWithOnlyLowConfidence(extractionSource: string) {
  return {
    extractionSource,
    retryCount: 0,
    maxRetries: 3,
    overallConfidence: 60,
    statements: [
      {
        statementType: 'INCOME_STATEMENT',
        unitScale: 'MILLIONS',
        currency: 'USD',
        periods: [
          {
            period: '2023',
            periodType: 'HISTORICAL',
            confidence: 65, // below CONFIDENCE_THRESHOLD — the ONLY actionable failure
            lineItems: { revenue: 100, cogs: 40, gross_profit: 60 }, // internally consistent — no math errors
          },
        ],
      },
    ],
  } as any;
}

describe('validateNode claude-source handling', () => {
  it('routes a legacy (gpt4o) source with failures to self_correcting as before', async () => {
    const validateNode = await getValidateNode();
    const result = await validateNode(stateWithFailingBalanceSheet('gpt4o'));
    expect(result.status).toBe('self_correcting');
    expect(result.steps?.some((s) => s.message.includes('routing to self-correction'))).toBe(true);
  });

  it('routes a claude source with error-severity failures to storing, claiming the repair pass ran (accurate — the engine DOES repair on these)', async () => {
    const validateNode = await getValidateNode();
    const result = await validateNode(stateWithFailingBalanceSheet('claude'));
    expect(result.status).toBe('storing');
    expect(result.steps?.some((s) => s.message.includes('routing to self-correction'))).toBe(false);
    expect(result.steps?.some((s) => s.message.includes("repair pass already ran"))).toBe(true);
  });

  it('routes a claude source with ONLY low-confidence failures to storing, WITHOUT claiming a repair pass ran (the engine never repairs on confidence alone)', async () => {
    // Regression: claudeEngine.ts's internal repair only triggers on
    // error-severity validateStatements() failures, not low-confidence
    // flags. Claiming "repair pass already ran" here would be inaccurate —
    // no repair call was ever made for this extraction.
    const validateNode = await getValidateNode();
    const result = await validateNode(stateWithOnlyLowConfidence('claude'));
    expect(result.status).toBe('storing');
    expect(result.steps?.some((s) => s.message.includes("repair pass already ran"))).toBe(false);
    expect(result.steps?.some((s) => s.message.includes('does not re-extract on confidence alone'))).toBe(true);
  });
});

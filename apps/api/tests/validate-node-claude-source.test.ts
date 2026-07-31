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

describe('validateNode claude-source handling', () => {
  it('routes a legacy (gpt4o) source with failures to self_correcting as before', async () => {
    const validateNode = await getValidateNode();
    const result = await validateNode(stateWithFailingBalanceSheet('gpt4o'));
    expect(result.status).toBe('self_correcting');
    expect(result.steps?.some((s) => s.message.includes('routing to self-correction'))).toBe(true);
  });

  it('routes a claude source with failures to storing, with an accurate log message', async () => {
    const validateNode = await getValidateNode();
    const result = await validateNode(stateWithFailingBalanceSheet('claude'));
    expect(result.status).toBe('storing');
    expect(result.steps?.some((s) => s.message.includes('routing to self-correction'))).toBe(false);
    expect(result.steps?.some((s) => s.message.includes("repair pass already ran"))).toBe(true);
  });
});

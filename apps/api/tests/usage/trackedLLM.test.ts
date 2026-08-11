import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));

vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertSpy,
      select: vi.fn(() => Promise.resolve({
        data: [
          { model: 'gpt-4o', provider: 'openai', inputPricePer1M: 2.5, outputPricePer1M: 10 },
        ],
        error: null,
      })),
    })),
  },
}));

vi.mock('../../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: vi.fn(async (op: string) => (op === 'deal_chat' ? 1 : 5)),
}));

// recordUsageEvent also writes a customer-visible AI_INFERENCE audit row on
// success (dynamic import of auditLog) — mock it so insertSpy counts only the
// UsageEvent insert these tests are about.
vi.mock('../../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

import { recordUsageEvent } from '../../src/services/usage/trackedLLM.js';
import { runWithUsageContext } from '../../src/middleware/usageContext.js';
import { _resetModelPriceCache } from '../../src/services/usage/modelPrices.js';

describe('recordUsageEvent', () => {
  beforeEach(() => {
    insertSpy.mockClear();
    _resetModelPriceCache();
  });

  it('inserts a UsageEvent with computed cost and credits', async () => {
    await runWithUsageContext(
      { userId: 'u1', organizationId: 'o1', source: 'test' },
      async () => {
        await recordUsageEvent({
          operation: 'deal_chat',
          model: 'gpt-4o',
          provider: 'openai',
          promptTokens: 1000,
          completionTokens: 500,
          status: 'success',
          durationMs: 250,
        });
      },
    );
    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.userId).toBe('u1');
    expect(row.organizationId).toBe('o1');
    expect(row.operation).toBe('deal_chat');
    expect(row.totalTokens).toBe(1500);
    expect(row.credits).toBe(1);
    // 1000 input × $2.5/1M + 500 output × $10/1M = $0.0025 + $0.005 = $0.0075
    expect(Number(row.costUsd)).toBeCloseTo(0.0075, 6);
    expect(row.metadata.priceLookupFailed).toBeUndefined();
  });

  it('marks priceLookupFailed=true when model is unknown', async () => {
    await runWithUsageContext(
      { userId: 'u1', organizationId: 'o1', source: 'test' },
      async () => {
        await recordUsageEvent({
          operation: 'deal_chat',
          model: 'totally-unknown-model',
          provider: 'openai',
          promptTokens: 100,
          completionTokens: 50,
          status: 'success',
        });
      },
    );
    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(Number(row.costUsd)).toBe(0);
    expect(row.metadata.priceLookupFailed).toBe(true);
  });

  it('skips insert when no usage context is bound', async () => {
    await recordUsageEvent({
      operation: 'deal_chat',
      model: 'gpt-4o',
      provider: 'openai',
      promptTokens: 100,
      completionTokens: 50,
      status: 'success',
    });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('uses unitCostUsd directly for non-LLM providers', async () => {
    await runWithUsageContext(
      { userId: 'u1', organizationId: 'o1', source: 'test' },
      async () => {
        await recordUsageEvent({
          operation: 'web_search',
          provider: 'apify',
          units: 3,
          unitCostUsd: 0.015,
          status: 'success',
        });
      },
    );
    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(Number(row.costUsd)).toBe(0.015);
    expect(row.units).toBe(3);
    expect(row.model).toBeNull();
  });

  it('does not throw when getCreditsForOperation throws', async () => {
    const { getCreditsForOperation } = await import('../../src/services/usage/operationCredits.js');
    vi.mocked(getCreditsForOperation).mockRejectedValueOnce(new Error('db down'));
    await runWithUsageContext(
      { userId: 'u1', organizationId: 'o1', source: 'test' },
      async () => {
        // Must not throw, must not crash
        await expect(recordUsageEvent({
          operation: 'deal_chat',
          model: 'gpt-4o',
          provider: 'openai',
          promptTokens: 100,
          completionTokens: 50,
          status: 'success',
        })).resolves.toBeUndefined();
      },
    );
    // Insert should not have been called because the function bailed out in catch
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

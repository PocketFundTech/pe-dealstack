import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));

vi.mock('../../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertSpy,
      select: vi.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  },
}));

vi.mock('../../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: vi.fn(async () => 1),
}));

vi.mock('../../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

import { runWithUsageContext } from '../../src/middleware/usageContext.js';
import {
  recordAnthropicMessageUsage,
  makeAnthropicUsageCallback,
} from '../../src/services/usage/trackedAnthropic.js';

describe('trackedAnthropic', () => {
  beforeEach(() => {
    insertSpy.mockClear();
  });

  describe('recordAnthropicMessageUsage', () => {
    it('splits cache_read and cache_creation (5m/1h) from the raw Anthropic usage shape', async () => {
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        await recordAnthropicMessageUsage({
          operation: 'firm_teaser',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 200,
            cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 },
          },
          status: 'success',
        });
      });
      expect(insertSpy).toHaveBeenCalledOnce();
      const row = insertSpy.mock.calls[0][0];
      expect(row.promptTokens).toBe(100);
      expect(row.completionTokens).toBe(50);
      expect(row.metadata.cacheReadTokens).toBe(200);
      expect(row.metadata.cacheWrite5mTokens).toBe(30);
      expect(row.metadata.cacheWrite1hTokens).toBe(10);
      // totalTokens = prompt + completion + all cache tokens
      expect(row.totalTokens).toBe(100 + 50 + 200 + 30 + 10);
      expect(row.provider).toBe('anthropic');
    });

    it('falls back to cache_creation_input_tokens as a 5m write when cache_creation is absent', async () => {
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        await recordAnthropicMessageUsage({
          operation: 'firm_teaser',
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 40,
          },
          status: 'success',
        });
      });
      const row = insertSpy.mock.calls[0][0];
      expect(row.metadata.cacheWrite5mTokens).toBe(40);
      expect(row.metadata.cacheWrite1hTokens).toBe(0);
    });

    it('records status error with zeroed tokens when usage is null', async () => {
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        await recordAnthropicMessageUsage({
          operation: 'firm_teaser',
          model: 'claude-sonnet-4-6',
          usage: null,
          status: 'error',
          metadata: { errorMessage: 'boom' },
        });
      });
      const row = insertSpy.mock.calls[0][0];
      expect(row.status).toBe('error');
      expect(row.promptTokens).toBe(0);
      expect(row.completionTokens).toBe(0);
      expect(row.metadata.errorMessage).toBe('boom');
    });
  });

  describe('makeAnthropicUsageCallback', () => {
    it('handleLLMEnd reads response_metadata.usage off the generation message and records success', async () => {
      const handler = makeAnthropicUsageCallback('reply_intent_classification', 'claude-sonnet-4-6');
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        await handler.handleLLMEnd!(
          {
            generations: [
              [
                {
                  message: {
                    response_metadata: {
                      usage: {
                        input_tokens: 20,
                        output_tokens: 8,
                        cache_read_input_tokens: 5,
                      },
                    },
                  },
                },
              ],
            ],
          } as any,
          {} as any,
        );
      });
      expect(insertSpy).toHaveBeenCalledOnce();
      const row = insertSpy.mock.calls[0][0];
      expect(row.promptTokens).toBe(20);
      expect(row.completionTokens).toBe(8);
      expect(row.metadata.cacheReadTokens).toBe(5);
      expect(row.status).toBe('success');
    });

    it('handleLLMError records status error', async () => {
      const handler = makeAnthropicUsageCallback('reply_intent_classification', 'claude-sonnet-4-6');
      await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
        await handler.handleLLMError!(new Error('rate limited'), {} as any);
      });
      expect(insertSpy).toHaveBeenCalledOnce();
      const row = insertSpy.mock.calls[0][0];
      expect(row.status).toBe('error');
      expect(row.metadata.errorMessage).toBe('rate limited');
    });
  });
});

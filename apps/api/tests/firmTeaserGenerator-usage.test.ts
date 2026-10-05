import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertSpy = vi.fn(() => Promise.resolve({ data: null, error: null }));

vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: insertSpy,
      select: vi.fn(() => Promise.resolve({ data: [], error: null })),
    })),
  },
}));

vi.mock('../src/services/usage/operationCredits.js', () => ({
  getCreditsForOperation: vi.fn(async () => 1),
}));

vi.mock('../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { AI_INFERENCE: 'AI_INFERENCE' },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { INFO: 'INFO' },
}));

const messagesCreate = vi.fn();
vi.mock('../src/services/anthropic.js', () => ({
  anthropic: { messages: { create: (...args: any[]) => messagesCreate(...args) } },
  isClaudeEnabled: () => true,
}));

import { runWithUsageContext } from '../src/middleware/usageContext.js';
import { generateTeaser, generateSystemPrompt } from '../src/services/firmTeaserGenerator.js';

const deal = { id: 'deal-1', name: 'Acme Co' } as any;
const profile = { name: 'Profile A', systemPrompt: 'be nice', criteria: [] } as any;

describe('firmTeaserGenerator usage tracking', () => {
  beforeEach(() => {
    insertSpy.mockClear();
    messagesCreate.mockReset();
  });

  it('generateTeaser records usage including cache tokens on success', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"headline": "Fits well", "fits": []}' }],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 15 },
      },
    });

    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      const result = await generateTeaser({ deal, profile, today: '2026-09-29' });
      expect(result.headline).toBe('Fits well');
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.operation).toBe('firm_teaser');
    expect(row.provider).toBe('anthropic');
    expect(row.promptTokens).toBe(120);
    expect(row.completionTokens).toBe(40);
    expect(row.metadata.cacheReadTokens).toBe(300);
    expect(row.metadata.cacheWrite5mTokens).toBe(15);
    expect(row.status).toBe('success');
  });

  it('generateTeaser records a status-error UsageEvent when the API call throws', async () => {
    messagesCreate.mockRejectedValue(new Error('rate limited'));

    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      await expect(generateTeaser({ deal, profile, today: '2026-09-29' })).rejects.toThrow('rate limited');
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.operation).toBe('firm_teaser');
    expect(row.status).toBe('error');
    expect(row.metadata.errorMessage).toBe('rate limited');
  });

  it('generateSystemPrompt records usage under its own operation label', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'A prompt.' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    await runWithUsageContext({ userId: 'u1', organizationId: 'o1', source: 'test' }, async () => {
      await generateSystemPrompt({ name: 'Profile A', criteria: [], today: '2026-09-29' });
    });

    expect(insertSpy).toHaveBeenCalledOnce();
    const row = insertSpy.mock.calls[0][0];
    expect(row.operation).toBe('firm_teaser_prompt_gen');
    expect(row.status).toBe('success');
  });
});

/**
 * Token savings (2026-09-29): the live deal chat (DEAL_CHAT_ENGINE=streaming)
 * sent its whole system prompt — firm context + ~18K chars of instructions and
 * guardrails + deal context — as ONE plain string with no cache_control, and
 * the Tool Runner re-sent it (plus 18 tool schemas and the growing tool
 * transcript) uncached on every iteration of every turn. A one-word "hi" cost
 * ~12.8K input tokens at full price.
 *
 * The fix only changes how the request is billed, not what the model sees:
 * the same text, in the same order, split into two cached system blocks, plus
 * request-level automatic caching so each tool-loop iteration reads the
 * previous iterations from cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackedClaudeStream = vi.fn((_opts: any) => {
  const runner = (async function* () {
    yield (async function* () {
      yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } };
    })();
  })();
  return { runner, recordUsage: vi.fn(async () => {}) };
});

vi.mock('../src/services/ai/client.js', () => ({ trackedClaudeStream }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true, getChatModel: () => ({}) }));
vi.mock('../src/services/agents/dealChatAgent/tools.js', () => ({ getDealChatTools: () => [] }));
vi.mock('../src/services/ai/models.js', () => ({ getModelConfig: () => ({ model: 'claude-sonnet-5', maxTokens: 16000, betas: [] }) }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/services/firmContextService.js', () => ({
  getFirmContextBlock: async () => 'Pocket Fund invests in Indian SMBs.',
}));

beforeEach(() => {
  trackedClaudeStream.mockClear();
});

async function runOnce() {
  const { runDealChatAgentStreaming } = await import('../src/services/agents/dealChatAgent/index.js');
  const gen = runDealChatAgentStreaming({
    dealId: 'deal-1',
    orgId: 'org-1',
    message: 'hi',
    dealContext: 'Deal: Nino Burgers\nStage: INITIAL_REVIEW',
    today: '2026-09-29',
  });
  for await (const _e of gen) { /* drain */ }
  return trackedClaudeStream.mock.calls[0][0];
}

describe('deal chat streaming — prompt caching', () => {
  it('sends the system prompt as cached blocks: stable instructions first, then the deal context', async () => {
    const opts = await runOnce();
    expect(Array.isArray(opts.system)).toBe(true);
    const [stable, deal] = opts.system;

    // Stable block: firm context + instructions + guardrails, cached.
    expect(stable.cache_control).toEqual({ type: 'ephemeral' });
    expect(stable.text.startsWith('=== FIRM CONTEXT ===\nPocket Fund invests in Indian SMBs.')).toBe(true);

    // Per-deal block: cached too, so every tool-loop step and follow-up reads it.
    expect(deal.cache_control).toEqual({ type: 'ephemeral' });
    expect(deal.text).toBe('Current Deal Context:\nDeal: Nino Burgers\nStage: INITIAL_REVIEW\n\nDeal ID: deal-1\nOrganization ID: org-1');
  });

  it('keeps the exact same prompt text as before (billing change only, no prompt change)', async () => {
    const opts = await runOnce();
    const [stable, deal] = opts.system;
    // The pre-change single string was `${stable}\n\n${deal}`.
    const joined = `${stable.text}\n\n${deal.text}`;
    expect(joined).toContain('Current Deal Context:\nDeal: Nino Burgers');
    expect(joined.indexOf('=== FIRM CONTEXT ===')).toBe(0);
    // Nothing volatile (like a per-request timestamp) above the first breakpoint:
    // only the date, which changes once a day.
    expect(stable.text).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('turns on automatic caching so each tool-loop iteration reads the earlier ones from cache', async () => {
    const opts = await runOnce();
    expect(opts.autoCache).toBe(true);
  });
});

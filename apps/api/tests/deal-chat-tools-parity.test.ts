/**
 * PROD GAP (2026-08-14): the streaming barrel (getDealChatTools, gated by
 * DEAL_CHAT_ENGINE=streaming) was silently missing 4 tools present on the
 * legacy barrel (web_search, generate_chart, get_recent_emails_for_deal,
 * get_upcoming_meetings_for_deal) — the flag stayed off specifically
 * because of this gap. This test pins name-set parity between the two
 * barrels so the flag can never be flipped with a silent capability loss
 * again.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag.js', () => ({
  isRAGEnabled: () => false,
  searchDocumentChunks: vi.fn(),
  buildRAGContext: vi.fn(),
}));

function toolName(t: any): string {
  // BetaRunnableTool objects expose `.name` directly; LangChain
  // StructuredTool instances expose it via `.name` too (set from the
  // `name` option passed to tool()), so this works across both shapes.
  return t.name;
}

describe('deal chat tool barrels — name-set parity', () => {
  it('getDealChatTools (streaming) and getDealChatToolsLegacy expose the same tool names', async () => {
    const { getDealChatTools, getDealChatToolsLegacy } = await import(
      '../src/services/agents/dealChatAgent/tools.js'
    );
    const noopEmit = () => {};
    const streamingNames = getDealChatTools('deal-1', 'org-1', noopEmit, 'user-1').map(toolName).sort();
    const legacyNames = getDealChatToolsLegacy('deal-1', 'org-1', 'user-1').map(toolName).sort();
    expect(streamingNames).toEqual(legacyNames);
  });

  it('both barrels include the four previously-streaming-only-missing tools', async () => {
    const { getDealChatTools } = await import('../src/services/agents/dealChatAgent/tools.js');
    const names = getDealChatTools('deal-1', 'org-1', () => {}, 'user-1').map(toolName);
    expect(names).toEqual(
      expect.arrayContaining([
        'web_search',
        'generate_chart',
        'get_recent_emails_for_deal',
        'get_upcoming_meetings_for_deal',
      ]),
    );
  });
});

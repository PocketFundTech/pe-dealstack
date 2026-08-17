/**
 * PROD REGRESSION (2026-08-17): generate_chart's input_schema used
 * `type: ['string', 'number']` for a union field. The Anthropic API
 * rejects an array-valued `type` in tool input_schema — the exact lesson
 * already recorded in services/extraction/extractionSchema.ts ("anyOf,
 * not type arrays"). Because generate_chart is unconditionally included
 * in every deal-chat tool call, this broke EVERY streaming chat request
 * from the moment DEAL_CHAT_ENGINE was flipped on, with zero visible
 * error (see the deals-chat-streaming-route.test.ts fix in the same
 * commit for that half of the incident).
 *
 * This test recursively scans every BetaRunnableTool's input_schema in
 * this barrel for an array-valued `type` field, so this exact class of
 * bug — in this tool or any tool added later — is caught before it ever
 * reaches a live Anthropic API call again.
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

function findArrayTypeFields(node: unknown, path: string, hits: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => findArrayTypeFields(item, `${path}[${i}]`, hits));
    return;
  }
  const obj = node as Record<string, unknown>;
  if ('type' in obj && Array.isArray(obj.type)) {
    hits.push(`${path}.type = ${JSON.stringify(obj.type)}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    findArrayTypeFields(value, `${path}.${key}`, hits);
  }
}

describe('deal chat tool schemas — no array-valued `type` fields', () => {
  it('every BetaRunnableTool input_schema in the streaming barrel is Anthropic-compatible', async () => {
    const { getDealChatTools } = await import('../src/services/agents/dealChatAgent/tools.js');
    const tools = getDealChatTools('deal-1', 'org-1', () => {}, 'user-1');

    const allHits: string[] = [];
    for (const tool of tools as Array<{ name: string; input_schema?: unknown }>) {
      if (!tool.input_schema) continue; // legacy-only shapes, if any, are covered separately
      const hits: string[] = [];
      findArrayTypeFields(tool.input_schema, tool.name, hits);
      allHits.push(...hits);
    }

    expect(allHits, `array-valued 'type' fields found (use anyOf instead): ${allHits.join(', ')}`).toEqual([]);
  });
});

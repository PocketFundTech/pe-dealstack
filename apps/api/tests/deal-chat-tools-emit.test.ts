import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('makeAddNoteTool emits a side_effect on success', () => {
  it('calls emit({type:"side_effect", effect:{type:"note_added"}}) after inserting', async () => {
    mockSupabase.from.mockImplementation(() => ({ insert: async () => ({ error: null }) }));
    const { makeAddNoteTool } = await import('../src/services/agents/dealChatAgent/tools/addNote.js');
    const emitted: any[] = [];
    const tool = makeAddNoteTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ content: 'called the seller', type: 'CALL_LOGGED' });
    expect(JSON.parse(result)).toEqual({ success: true, type: 'note_added' });
    expect(emitted).toEqual([{ type: 'side_effect', effect: { type: 'note_added' } }]);
  });

  it('does not emit on failure', async () => {
    mockSupabase.from.mockImplementation(() => ({ insert: async () => { throw new Error('db down'); } }));
    const { makeAddNoteTool } = await import('../src/services/agents/dealChatAgent/tools/addNote.js');
    const emitted: any[] = [];
    const tool = makeAddNoteTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ content: 'x', type: 'NOTE_ADDED' });
    expect(JSON.parse(result).success).toBe(false);
    expect(emitted).toEqual([]);
  });
});

describe('makeChangeDealStageTool emits an update on success', () => {
  it('calls emit({type:"update", update:{field:"stage",...}}) after the stage change', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { stage: 'INITIAL_REVIEW' } }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      return { insert: async () => ({ error: null }) };
    });
    const { makeChangeDealStageTool } = await import('../src/services/agents/dealChatAgent/tools/changeDealStage.js');
    const emitted: any[] = [];
    const tool = makeChangeDealStageTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ stage: 'DUE_DILIGENCE' });
    expect(JSON.parse(result)).toEqual({ success: true, field: 'stage', value: 'DUE_DILIGENCE', previousStage: 'INITIAL_REVIEW' });
    expect(emitted).toEqual([{ type: 'update', update: { field: 'stage', value: 'DUE_DILIGENCE', previousStage: 'INITIAL_REVIEW' } }]);
  });
});

describe('makeSuggestActionTool emits an action', () => {
  it('calls emit({type:"action", action:{...}})', async () => {
    const { makeSuggestActionTool } = await import('../src/services/agents/dealChatAgent/tools/navigation.js');
    const emitted: any[] = [];
    const tool = makeSuggestActionTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ actionType: 'create_memo', label: 'Create Memo' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ type: 'create_memo', label: 'Create Memo', description: undefined, url: '/memo-builder?dealId=deal-1&fromChat=1' });
    expect(emitted).toEqual([{ type: 'action', action: parsed }]);
  });
});

describe('makeScrollToSectionTool emits a side_effect', () => {
  it('calls emit({type:"side_effect", effect:{type:"scroll_to", section}})', async () => {
    const { makeScrollToSectionTool } = await import('../src/services/agents/dealChatAgent/tools/navigation.js');
    const emitted: any[] = [];
    const tool = makeScrollToSectionTool('deal-1', 'org-1', (e: any) => emitted.push(e));
    const result = await tool.run({ section: 'financials' });
    expect(JSON.parse(result)).toEqual({ type: 'scroll_to', section: 'financials' });
    expect(emitted).toEqual([{ type: 'side_effect', effect: { type: 'scroll_to', section: 'financials' } }]);
  });
});

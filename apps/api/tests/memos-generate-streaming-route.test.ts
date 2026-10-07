/**
 * POST /api/memos/:id/generate-all — SSE route tests (Phase 3-A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));

let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  isAnthropicAvailable: () => anthropicAvailable,
}));

const generateAllSectionsStreaming = vi.fn();
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  generateAllSectionsStreaming: (...args: any[]) => generateAllSectionsStreaming(...args),
}));

const updateSpy = vi.fn(() => ({ eq: async () => ({ error: null }) }));
const insertSpy = vi.fn(async () => ({ error: null }));
let existingSectionRows: Array<{ id: string; type: string; title: string }> = [];

function tableMock() {
  return (table: string) => {
    if (table === 'Memo') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'memo-1', dealId: 'deal-1' } }) }) }) }) };
    }
    if (table === 'MemoSection') {
      return {
        select: () => ({ eq: () => ({
          // First call (existing rows pre-fetch): no eq chain further, just resolves.
          then: (resolve: any) => resolve({ data: existingSectionRows }),
          order: async () => ({ data: [{ id: 'sec-1', type: 'EXECUTIVE_SUMMARY', content: 'final', sortOrder: 1 }] }),
        }) }),
        update: updateSpy,
        insert: insertSpy,
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/memos-generate.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memos', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  anthropicAvailable = true;
  existingSectionRows = [];
  mockSupabase.from.mockImplementation(tableMock());
});

describe('POST /api/memos/:id/generate-all — SSE', () => {
  it('streams every generator event and ends with a persisted done frame', async () => {
    generateAllSectionsStreaming.mockReturnValue((async function* () {
      yield { type: 'section_start', sectionType: 'EXECUTIVE_SUMMARY', index: 1, total: 1 };
      yield { type: 'section_complete', sectionType: 'EXECUTIVE_SUMMARY', section: { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'draft', aiGenerated: true, aiModel: 'claude-sonnet-5' }, index: 1, total: 1 };
      yield { type: 'critique_start' };
      yield { type: 'done', sections: [{ type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'final', aiGenerated: true, aiModel: 'claude-sonnet-5', sortOrder: 1 }], context: {} };
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"section_start"');
    expect(res.text).toContain('"type":"section_complete"');
    expect(res.text).toContain('"type":"critique_start"');
    // The done frame is re-shaped by the route (persisted rows), not forwarded raw.
    expect(res.text).toContain('"success":true');
    expect(res.text).toContain('"sec-1"');
  });

  it('persists a section as soon as it completes, before the run finishes (Batch 3)', async () => {
    generateAllSectionsStreaming.mockReturnValue((async function* () {
      yield { type: 'section_complete', sectionType: 'EXECUTIVE_SUMMARY', section: { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'draft', aiGenerated: true, aiModel: 'claude-sonnet-5' }, index: 1, total: 2 };
      // Simulate the run dying before the second section or 'done' ever arrives
      // (timeout, crash, etc.) — the first section must already be saved.
      throw new Error('agent crashed mid-run');
    })());

    const app = await buildApp();
    await request(app).post('/api/memos/memo-1/generate-all').send({});

    // insertSpy fires because the mocked existing-rows select returns [] (no
    // row for EXECUTIVE_SUMMARY yet), so persistGeneratedSections inserts it.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][0]).toMatchObject([{ content: 'draft' }]);
  });

  it('sends an error frame when the generator ends without a done event', async () => {
    generateAllSectionsStreaming.mockReturnValue((async function* () {
      yield { type: 'section_complete', sectionType: 'EXECUTIVE_SUMMARY', section: { type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', content: 'draft', aiGenerated: true }, index: 1, total: 1 };
      // No 'done' — generator just ends (distinct from throwing).
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});

    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('saved');
  });

  // QA 2026-10-06 #16b: a memo created from the Standard IC Memo template
  // clones MemoSection rows typed via SECTION_TYPE_MAP (the DB-normalized
  // type), e.g. "Exit Analysis" -> EXIT_STRATEGY, "Management Assessment"
  // and "Operational Deep Dive" -> CUSTOM. The generator emits its OWN raw
  // type names (EXIT_ANALYSIS, MANAGEMENT_ASSESSMENT, ...) for those same
  // sections. Matching on the raw type never found the existing row, so
  // "Generate all" inserted a second, duplicate row for every one of these
  // five sections on every run.
  it('updates the existing cloned row instead of inserting a duplicate for a remapped type', async () => {
    existingSectionRows = [
      { id: 'existing-exit', type: 'EXIT_STRATEGY', title: 'Exit Analysis' },
      { id: 'existing-mgmt', type: 'CUSTOM', title: 'Management Assessment' },
      { id: 'existing-ops', type: 'CUSTOM', title: 'Operational Deep Dive' },
    ];
    generateAllSectionsStreaming.mockReturnValue((async function* () {
      yield {
        type: 'section_complete',
        sectionType: 'EXIT_ANALYSIS',
        section: { type: 'EXIT_ANALYSIS', title: 'Exit Analysis', content: 'exit content', aiGenerated: true },
        index: 1, total: 3,
      };
      yield {
        type: 'section_complete',
        sectionType: 'MANAGEMENT_ASSESSMENT',
        section: { type: 'MANAGEMENT_ASSESSMENT', title: 'Management Assessment', content: 'mgmt content', aiGenerated: true },
        index: 2, total: 3,
      };
      yield {
        type: 'section_complete',
        sectionType: 'OPERATIONAL_DEEP_DIVE',
        section: { type: 'OPERATIONAL_DEEP_DIVE', title: 'Operational Deep Dive', content: 'ops content', aiGenerated: true },
        index: 3, total: 3,
      };
    })());

    const app = await buildApp();
    await request(app).post('/api/memos/memo-1/generate-all').send({});

    expect(insertSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledTimes(3);
  });

  it('returns 503 JSON (not SSE) when Anthropic is unavailable, without opening a stream', async () => {
    anthropicAvailable = false;
    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/json');
    expect(generateAllSectionsStreaming).not.toHaveBeenCalled();
  });
});

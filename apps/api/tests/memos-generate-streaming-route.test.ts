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

function tableMock() {
  return (table: string) => {
    if (table === 'Memo') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'memo-1', dealId: 'deal-1' } }) }) }) }) };
    }
    if (table === 'MemoSection') {
      return {
        select: () => ({ eq: () => ({
          // First call (existing rows pre-fetch): no eq chain further, just resolves.
          then: (resolve: any) => resolve({ data: [] }),
          order: async () => ({ data: [{ id: 'sec-1', type: 'EXECUTIVE_SUMMARY', content: 'final', sortOrder: 1 }] }),
        }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
        insert: async () => ({ error: null }),
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

  it('returns 503 JSON (not SSE) when Anthropic is unavailable, without opening a stream', async () => {
    anthropicAvailable = false;
    const app = await buildApp();
    const res = await request(app).post('/api/memos/memo-1/generate-all').send({});
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/json');
    expect(generateAllSectionsStreaming).not.toHaveBeenCalled();
  });
});

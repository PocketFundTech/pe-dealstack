import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks BEFORE importing the router
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const isAIEnabled = vi.fn(() => true);
const trackedChatCompletion = vi.fn(async () => ({
  choices: [{ message: { content: '<p>injected AI content</p>' } }],
}));
vi.mock('../src/openai.js', () => ({ isAIEnabled, trackedChatCompletion }));

vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { aiGenerate: vi.fn(), log: vi.fn() },
}));
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  runMemoChatAgent: vi.fn(),
}));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true }));
vi.mock('../src/services/firmContextService.js', () => ({ getFirmContextBlock: async () => '' }));
vi.mock('../src/utils/aiModels.js', () => ({ MODEL_REASONING: 'mock-model' }));
vi.mock('../src/utils/aiErrors.js', () => ({
  classifyAIErrorObject: () => ({ statusCode: 500, userMessage: 'fail' }),
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/memos-chat.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/memos', router);
  return app;
};

describe('POST /api/memos/:id/sections/:sectionId/generate — F-10 cross-memo bind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    isAIEnabled.mockReturnValue(true);
  });

  it('returns 404 when sectionId does not belong to memo (cross-org AI write blocked)', async () => {
    type Filter = { col: string; val: any };
    const sectionFilters: Filter[] = [];
    let sectionUpdateInvoked = false;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        // .from('Memo').select(...).eq('id', id).eq('organizationId', orgId).single()
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 'memo-A', title: 'Memo A', projectName: 'p', deal: null },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: (col: string, val: any) => {
              sectionFilters.push({ col, val });
              return {
                eq: (col2: string, val2: any) => {
                  sectionFilters.push({ col: col2, val: val2 });
                  return {
                    single: async () => ({ data: null, error: { code: 'PGRST116' } }),
                  };
                },
                single: async () => {
                  // Buggy single-eq path. If the handler hits this, it found
                  // the cross-org section and would proceed with AI write.
                  return {
                    data: {
                      id: 'cross-org-section',
                      memoId: 'other-memo',
                      type: 'CUSTOM',
                      title: 'pwned',
                    },
                    error: null,
                  };
                },
              };
            },
          }),
          update: () => {
            sectionUpdateInvoked = true;
            return {
              eq: (col: string, val: any) => {
                sectionFilters.push({ col, val });
                return {
                  eq: (col2: string, val2: any) => {
                    sectionFilters.push({ col: col2, val: val2 });
                    return {
                      select: () => ({
                        single: async () => ({ data: null, error: { code: 'PGRST116' } }),
                      }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/memos/memo-A/sections/cross-org-section/generate')
      .send({});

    // Either 404 (preferred — handler refuses) or 500 with no update call.
    // The critical contract: section update path must NOT have been invoked
    // OR if it was, it had a memoId filter.
    expect(sectionUpdateInvoked).toBe(false);
    expect(trackedChatCompletion).not.toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Section fetch must have filtered on memoId.
    const cols = sectionFilters.map((f) => f.col);
    expect(cols).toContain('memoId');
  });

  it('generates content when sectionId belongs to verified memo', async () => {
    let updateMemoIdFilter: string | null = null;

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Memo') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'memo-A',
                    title: 'Memo A',
                    projectName: 'p',
                    deal: null,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'MemoSection') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: 'section-A',
                    memoId: 'memo-A',
                    type: 'CUSTOM',
                    title: 'Section A',
                  },
                  error: null,
                }),
              }),
            }),
          }),
          update: () => ({
            eq: (col: string, val: any) => {
              return {
                eq: (col2: string, val2: any) => {
                  if (col2 === 'memoId') updateMemoIdFilter = val2;
                  return {
                    select: () => ({
                      single: async () => ({
                        data: {
                          id: 'section-A',
                          memoId: 'memo-A',
                          content: '<p>injected AI content</p>',
                        },
                        error: null,
                      }),
                    }),
                  };
                },
              };
            },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/memos/memo-A/sections/section-A/generate')
      .send({});

    expect(res.status).toBe(200);
    expect(trackedChatCompletion).toHaveBeenCalledTimes(1);
    expect(updateMemoIdFilter).toBe('memo-A');
  });
});

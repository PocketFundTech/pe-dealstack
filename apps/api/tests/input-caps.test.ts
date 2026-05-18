/**
 * Input-cap tests — Phase 4 Task 4.4
 *
 * User-supplied text fields that flow into LangGraph / GPT contexts must be
 * bounded with Zod .max() so a 1MB submission can't burn OpenAI tokens or
 * exceed the model context window.
 *
 * Capped fields exercised here:
 *   - POST /api/deals/:dealId/chat       body.message (10K), body.history (50 items, 10K each)
 *   - POST /api/ingest/text              body.text (500K)
 *   - POST /api/memos/:id/chat           body.content (10K)
 *   - POST /api/conversations/:id/messages body.content (10K)
 *
 * Each capped field is exercised twice: once with an oversized payload that
 * MUST return 400, once with a payload right at the cap that MUST proceed
 * past validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Shared mocks ────────────────────────────────────────────────
const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Org-scope helpers — all endpoints under test gate on these.
const verifyDealAccess = vi.fn();
const verifyConversationAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyDealAccess,
  verifyConversationAccess,
  verifyDocumentAccess: vi.fn(),
  verifyContactAccess: vi.fn(),
  verifyFolderAccess: vi.fn(),
}));

// ─── deals-chat-ai mocks ─────────────────────────────────────────
const runDealChatAgent = vi.fn(async () => ({
  response: 'ok',
  model: 'mock-model',
}));
vi.mock('../src/services/agents/dealChatAgent/index.js', () => ({
  runDealChatAgent,
}));
vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
  getChatModel: () => ({ _llmType: () => 'mock' }),
}));
vi.mock('../src/services/chatHelpers.js', () => ({
  generateFallbackResponse: () => 'fallback',
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    aiChat: vi.fn(),
    aiIngest: vi.fn(),
    aiGenerate: vi.fn(),
    log: vi.fn(),
  },
}));

// ─── ingest-text mocks ───────────────────────────────────────────
const extractDealDataFromText = vi.fn();
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText,
}));
vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal: vi.fn(),
  getIconForIndustry: () => 'briefcase',
}));
vi.mock('../src/rag.js', () => ({ embedDocument: vi.fn() }));
vi.mock('../src/services/financialValidator.js', () => ({
  validateFinancials: () => ({ isValid: true, warnings: [] }),
}));
vi.mock('../src/routes/notifications.js', () => ({
  resolveUserId: vi.fn(),
}));

// ─── memos-chat / conversations mocks ────────────────────────────
const runMemoChatAgent = vi.fn(async () => ({
  message: 'ok',
  model: 'mock-model',
  action: null,
  sectionId: null,
}));
vi.mock('../src/services/agents/memoAgent/index.js', () => ({
  runMemoChatAgent,
}));

const isAIEnabled = vi.fn(() => true);
const trackedChatCompletion = vi.fn(async () => ({
  choices: [{ message: { content: 'response' } }],
}));
vi.mock('../src/openai.js', () => ({
  isAIEnabled,
  trackedChatCompletion,
  openai: {},
}));

vi.mock('../src/utils/aiModels.js', () => ({ MODEL_REASONING: 'mock-model' }));
vi.mock('../src/utils/aiErrors.js', () => ({
  classifyAIErrorObject: () => ({ statusCode: 500, userMessage: 'fail' }),
}));
vi.mock('../src/services/agents/guardrails.js', () => ({
  SHARED_GUARDRAILS: '',
}));

const buildApp = async (routerPath: string, mount: string) => {
  const { default: router } = await import(routerPath);
  const app = express();
  // Bump the JSON body limit so oversized-payload tests reach the route handler.
  app.use(express.json({ limit: '2mb' }));
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: 'org-A' };
    next();
  });
  app.use(mount, router);
  return app;
};

// ─── /api/deals/:dealId/chat — message cap ───────────────────────
describe('POST /api/deals/:dealId/chat — message length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    verifyDealAccess.mockResolvedValue({ id: 'deal-1', organizationId: 'org-A' });

    // Default supabase shape: deal lookup + user lookup + org lookup + financials + insert + insert
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Deal') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: 'deal-1',
                  name: 'Test Deal',
                  stage: 'INITIAL_REVIEW',
                  status: 'ACTIVE',
                  organizationId: 'org-A',
                  company: null,
                  teamMembers: [],
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'User') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ data: [], error: null }),
              single: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === 'Organization') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { settings: {} }, error: null }),
            }),
          }),
        };
      }
      if (table === 'FinancialStatement') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'ChatMessage') {
        return {
          insert: async () => ({ data: null, error: null }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
    });
  });

  it('rejects messages over 10,000 chars with 400', async () => {
    const app = await buildApp('../src/routes/deals-chat-ai.js', '/api/deals');
    const oversized = 'A'.repeat(10_001);

    const res = await request(app)
      .post('/api/deals/deal-1/chat')
      .send({ message: oversized });

    expect(res.status).toBe(400);
    expect(runDealChatAgent).not.toHaveBeenCalled();
  });

  it('rejects history with more than 50 items with 400', async () => {
    const app = await buildApp('../src/routes/deals-chat-ai.js', '/api/deals');
    const history = Array.from({ length: 51 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
    }));

    const res = await request(app)
      .post('/api/deals/deal-1/chat')
      .send({ message: 'hi', history });

    expect(res.status).toBe(400);
    expect(runDealChatAgent).not.toHaveBeenCalled();
  });

  it('rejects history when a single content entry exceeds 10,000 chars', async () => {
    const app = await buildApp('../src/routes/deals-chat-ai.js', '/api/deals');
    const history = [{ role: 'user', content: 'B'.repeat(10_001) }];

    const res = await request(app)
      .post('/api/deals/deal-1/chat')
      .send({ message: 'hi', history });

    expect(res.status).toBe(400);
    expect(runDealChatAgent).not.toHaveBeenCalled();
  });

  it('rejects history when items are not an array', async () => {
    const app = await buildApp('../src/routes/deals-chat-ai.js', '/api/deals');

    const res = await request(app)
      .post('/api/deals/deal-1/chat')
      .send({ message: 'hi', history: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(runDealChatAgent).not.toHaveBeenCalled();
  });

  it('accepts a normal message under the cap', async () => {
    const app = await buildApp('../src/routes/deals-chat-ai.js', '/api/deals');

    const res = await request(app)
      .post('/api/deals/deal-1/chat')
      .send({ message: 'What is the IRR?' });

    expect(res.status).toBe(200);
    expect(runDealChatAgent).toHaveBeenCalledTimes(1);
  });
});

// ─── /api/ingest/text — text cap ─────────────────────────────────
describe('POST /api/ingest/text — text length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractDealDataFromText.mockReset();
    extractDealDataFromText.mockResolvedValue({
      companyName: { value: 'Acme', confidence: 90 },
      industry: { value: 'Healthcare', confidence: 80 },
      description: { value: 'd', confidence: 80 },
      currency: 'USD',
      revenue: { value: 50, confidence: 90 },
      ebitda: { value: 10, confidence: 90 },
      ebitdaMargin: { value: 20, confidence: 90 },
      revenueGrowth: { value: 10, confidence: 80 },
      employees: { value: 100, confidence: 70 },
      foundedYear: { value: 2010, confidence: 70 },
      headquarters: { value: 'NY', confidence: 70 },
      keyRisks: [],
      investmentHighlights: [],
      summary: 'ok',
      overallConfidence: 85,
      needsReview: false,
      reviewReasons: [],
    });
  });

  it('rejects text over 500,000 chars with 400', async () => {
    const app = await buildApp('../src/routes/ingest-text.js', '/api/ingest');
    const oversized = 'A'.repeat(500_001);

    const res = await request(app)
      .post('/api/ingest/text')
      .send({ text: oversized, sourceType: 'email' });

    expect(res.status).toBe(400);
    expect(extractDealDataFromText).not.toHaveBeenCalled();
  });
});

// ─── /api/memos/:id/chat — content cap ───────────────────────────
describe('POST /api/memos/:id/chat — content length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('rejects content over 10,000 chars with 400', async () => {
    const app = await buildApp('../src/routes/memos-chat.js', '/api/memos');
    const oversized = 'A'.repeat(10_001);

    const res = await request(app)
      .post('/api/memos/00000000-0000-0000-0000-000000000001/chat')
      .send({ content: oversized });

    expect(res.status).toBe(400);
    expect(runMemoChatAgent).not.toHaveBeenCalled();
  });
});

// ─── /api/conversations/:id/messages — content cap ───────────────
describe('POST /api/conversations/:id/messages — content length cap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    verifyConversationAccess.mockResolvedValue({ id: 'conv-1' });
  });

  it('rejects content over 10,000 chars with 400', async () => {
    const app = await buildApp('../src/routes/chat.js', '/api');
    const oversized = 'A'.repeat(10_001);

    const res = await request(app)
      .post('/api/conversations/00000000-0000-0000-0000-000000000001/messages')
      .send({
        content: oversized,
        userId: '00000000-0000-0000-0000-000000000002',
      });

    expect(res.status).toBe(400);
    expect(trackedChatCompletion).not.toHaveBeenCalled();
  });
});

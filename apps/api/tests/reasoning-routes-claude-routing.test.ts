import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * AI cost plan G1: MODEL_REASONING resolves to 'claude-sonnet-4-6' whenever
 * an Anthropic key is set, but memo section regenerate, the legacy
 * conversation chat and generate-thesis sent it to the OpenAI client
 * (trackedChatCompletion), which can't serve a claude-* model — every call
 * failed. They now go through the provider-aware getChatModel().
 *
 * The OpenAI mock below reproduces production: any claude-* model 404s.
 */

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
const mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({
  supabase: { from: (t: string) => mock.from(t) },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const trackedChatCompletion = vi.fn(async (_op: string, params: any) => {
  if (String(params.model).startsWith('claude')) {
    throw Object.assign(new Error(`404 The model \`${params.model}\` does not exist`), { status: 404 });
  }
  return { choices: [{ message: { content: 'openai reply' } }] };
});
vi.mock('../src/openai.js', () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  isAIEnabled: () => true,
  trackedChatCompletion: (...a: any[]) => (trackedChatCompletion as any)(...a),
  DEAL_ANALYSIS_SYSTEM_PROMPT: 'deal analysis prompt',
  generateDealContext: () => 'Deal: Acme',
}));
vi.mock('../src/utils/aiModels.js', () => ({
  MODEL_REASONING: 'claude-sonnet-4-6',
  MODEL_CLASSIFICATION: 'gpt-4.1',
}));

const chatInvoke = vi.fn(async (_messages: any[]) => ({
  content: [{ type: 'text', text: 'claude reply' }],
}));
const getChatModel = vi.fn((_t?: number, _m?: number, _op?: string) => ({ invoke: chatInvoke }));
vi.mock('../src/services/llm.js', () => ({
  isLLMAvailable: () => true,
  getChatModel: (...a: any[]) => (getChatModel as any)(...a),
}));

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDealAccess: vi.fn(async () => ({ id: 'deal-1', organizationId: 'org-A' })),
  verifyConversationAccess: vi.fn(async () => ({ id: 'conv-1' })),
}));
vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: { aiGenerate: vi.fn(), log: vi.fn() },
}));
vi.mock('../src/services/firmContextService.js', () => ({ getFirmContextBlock: async () => '' }));
vi.mock('../src/services/agents/memoAgent/index.js', () => ({ runMemoChatAgent: vi.fn() }));
vi.mock('../src/services/agents/dealChatAgent/index.js', () => ({ runDealChatAgent: vi.fn() }));
vi.mock('../src/services/agents/globalChatAgent/index.js', () => ({
  runGlobalChatAgent: vi.fn(),
  streamGlobalChatAgent: vi.fn(),
}));
vi.mock('../src/services/agents/guardrails.js', () => ({ SHARED_GUARDRAILS: '' }));
vi.mock('../src/services/aiCache.js', () => ({
  AICache: {
    getThesis: vi.fn(async () => ({ hit: false })),
    setThesis: vi.fn(async () => {}),
  },
}));
vi.mock('../src/routes/notifications.js', () => ({ notifyDealTeam: vi.fn(), resolveUserId: vi.fn() }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));
vi.mock('../src/routes/ai-ingest.js', () => ({ default: express.Router() }));
vi.mock('../src/routes/ai-portfolio.js', () => ({ default: express.Router() }));
vi.mock('../src/routes/ai-agents.js', () => ({ default: express.Router() }));

async function buildApp(routerPath: string, mount: string, user = true) {
  const { default: router } = await import(routerPath);
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req: any, _res, next) => {
      req.user = { id: 'auth-user-1', organizationId: 'org-A' };
      next();
    });
  }
  app.use(mount, router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.calls.length = 0;
});

describe('claude-* MODEL_REASONING routes go through getChatModel, not the OpenAI client', () => {
  it('POST /memos/:id/sections/:sectionId/generate stores the Claude reply', async () => {
    resolver = (op) => {
      if (op.table === 'Memo') return { data: { id: 'memo-A', title: 'Memo A', projectName: 'p', deal: null } };
      if (op.table === 'MemoSection' && op.action === 'select') {
        return { data: { id: 'sec-1', memoId: 'memo-A', type: 'CUSTOM', title: 'Thesis', content: '' } };
      }
      if (op.table === 'MemoSection' && op.action === 'update') {
        return { data: { id: 'sec-1', ...(op.payload as object) } };
      }
      return {};
    };
    const app = await buildApp('../src/routes/memos-chat.js', '/api/memos');
    const res = await request(app).post('/api/memos/memo-A/sections/sec-1/generate').send({});

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('claude reply');
    expect(res.body.aiGenerated).toBe(true);
    expect(trackedChatCompletion).not.toHaveBeenCalled();
    expect(getChatModel).toHaveBeenCalledWith(0.7, 2000, 'memo_generation');
  });

  it('POST /conversations/:id/messages saves the Claude reply (not the error apology)', async () => {
    resolver = (op) => {
      if (op.table === 'Conversation' && op.action === 'select') {
        return {
          data: {
            id: 'conv-1',
            dealId: 'deal-1',
            userId: null,
            Deal: { id: 'deal-1', name: 'Acme', stage: 'SCREENING', organizationId: 'org-A' },
            ChatMessage: [
              { id: 'm1', role: 'user', content: 'earlier q', createdAt: '2026-10-01' },
              { id: 'm2', role: 'assistant', content: 'earlier a', createdAt: '2026-10-01' },
            ],
          },
        };
      }
      if (op.table === 'ChatMessage' && op.action === 'insert') {
        return { data: { id: 'new', ...(op.payload as object) } };
      }
      return {};
    };
    const app = await buildApp('../src/routes/chat.js', '/api');
    const res = await request(app).post('/api/conversations/conv-1/messages').send({ content: 'What is EBITDA?', userId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(200);
    expect(res.body.aiMessage.content).toBe('claude reply');
    expect(res.body.userMessage.content).toBe('What is EBITDA?');
    expect(trackedChatCompletion).not.toHaveBeenCalled();
    expect(getChatModel).toHaveBeenCalledWith(0.7, 4096, 'deal_chat');
    // system + 2 history turns + current user message, in order
    const sent = chatInvoke.mock.calls[0][0];
    expect(sent.map((m: any) => m._getType())).toEqual(['system', 'human', 'ai', 'human']);
    expect(sent[3].content).toBe('What is EBITDA?');
  });

  it('POST /deals/:dealId/generate-thesis returns the Claude thesis', async () => {
    resolver = (op) => {
      if (op.table === 'Deal') return { data: { id: 'deal-1', name: 'Acme', stage: 'SCREENING' } };
      return {};
    };
    const app = await buildApp('../src/routes/ai.js', '/api', false);
    const res = await request(app).post('/api/deals/deal-1/generate-thesis').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ thesis: 'claude reply', dealId: 'deal-1', cached: false });
    expect(trackedChatCompletion).not.toHaveBeenCalled();
    expect(getChatModel).toHaveBeenCalledWith(0.7, 300, 'deal_analysis');
  });
});

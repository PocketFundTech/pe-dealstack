import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiChat: vi.fn(async () => {}) } }));
vi.mock('../src/services/llm.js', () => ({ isLLMAvailable: () => true }));
vi.mock('../src/services/chatHelpers.js', () => ({ generateFallbackResponse: () => 'fallback' }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => ({ id: 'deal-1' })),
}));

const runDealChatAgent = vi.fn();
const runDealChatAgentStreaming = vi.fn();
vi.mock('../src/services/agents/dealChatAgent/index.js', () => ({ runDealChatAgent, runDealChatAgentStreaming }));

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'deal-1', name: 'Acme', stage: 'DILIGENCE', status: 'ACTIVE', organizationId: 'org-1', company: null, teamMembers: [] }, error: null }) }) }) };
    }
    if (table === 'User') {
      return {
        select: () => ({
          eq: () => ({ order: async () => ({ data: [] }), single: async () => ({ data: null }) }),
        }),
      };
    }
    if (table === 'Organization') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { settings: {} } }) }) }) };
    }
    if (table === 'FinancialStatement') {
      return { select: () => ({ eq: () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }) }) };
    }
    if (table === 'ChatMessage') {
      return { insert: async (row: any) => { insertedRows.push(row); return { error: null }; } };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

let insertedRows: any[] = [];

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-chat-ai.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRows = [];
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.DEAL_CHAT_ENGINE;
});

describe('POST /api/deals/:dealId/chat — DEAL_CHAT_ENGINE=streaming', () => {
  it('streams SSE events and persists the accumulated assistant text', async () => {
    process.env.DEAL_CHAT_ENGINE = 'streaming';
    runDealChatAgentStreaming.mockReturnValue((async function* () {
      yield { type: 'tool_start', tool: 'search_documents', label: 'Searching documents...' };
      yield { type: 'text_delta', text: 'Hello' };
      yield { type: 'text_delta', text: ' there' };
      yield { type: 'done', response: 'Hello there', model: 'claude-sonnet-5', truncated: false };
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"tool_start"');
    expect(res.text).toContain('"type":"text_delta"');
    expect(res.text).toContain('"type":"done"');

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow.content).toBe('Hello there');
    expect(assistantRow.metadata.truncated).toBeUndefined();
  });

  it('persists the partial text with metadata.truncated on an error event', async () => {
    process.env.DEAL_CHAT_ENGINE = 'streaming';
    runDealChatAgentStreaming.mockReturnValue((async function* () {
      yield { type: 'text_delta', text: 'partial answ' };
      yield { type: 'error', message: 'Response timed out after 30000ms. Please try again.' };
    })());

    const app = await buildApp();
    await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow.content).toBe('partial answ');
    expect(assistantRow.metadata.truncated).toBe(true);
  });

  // PROD REGRESSION (2026-08-17): the day DEAL_CHAT_ENGINE was flipped on,
  // the very first real request threw before the generator's first yield
  // (root cause: an invalid tool schema — `type: ['string','number']` in
  // generate_chart, which the Anthropic API rejects; fixed alongside this
  // test in the same commit). The route's catch block only logged the
  // error server-side and called res.end() — the client's SSE reader saw
  // headers, then a connection that closed with ZERO data frames. The chat
  // UI rendered a completely blank reply with no error message. This test
  // pins the fix: an exception before any yield MUST still produce a
  // `type:"error"` SSE frame so the frontend's existing (and already
  // correct) error handler can render it.
  it('sends an SSE error event when the generator throws before its first yield', async () => {
    process.env.DEAL_CHAT_ENGINE = 'streaming';
    runDealChatAgentStreaming.mockReturnValue((async function* () {
      throw new Error('400 invalid_request_error: tool schema rejected');
      // eslint-disable-next-line no-unreachable
      yield { type: 'text_delta', text: 'never reached' };
    })());

    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"error"');
    expect(res.text.length).toBeGreaterThan(0);
  });
});

describe('POST /api/deals/:dealId/chat — DEAL_CHAT_ENGINE unset (legacy)', () => {
  it('calls runDealChatAgent and returns buffered JSON, unchanged', async () => {
    runDealChatAgent.mockResolvedValue({ response: 'ok', model: 'gpt-4o (ReAct agent)' });
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/chat').send({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ response: 'ok', model: 'gpt-4o (ReAct agent)' });
    expect(runDealChatAgentStreaming).not.toHaveBeenCalled();
  });
});

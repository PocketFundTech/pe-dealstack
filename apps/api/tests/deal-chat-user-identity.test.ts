/**
 * PROD BUG (2026-09-29): deal chat greeted Ganesh as "Hi Dev". The prompt
 * never stated who the current user is; it only injected the onboarding
 * research blob (User.onboardingStatus.personProfile) as "Your Role: …".
 * That blob had been researched from a different person's LinkedIn and its
 * `title` field held a name ("Dev Shah"), so the model addressed the user as
 * Dev. The user's own Settings values (User.name / User.title) were correct
 * but never reached the prompt.
 *
 * The chat must identify the user from the Settings fields they control, and
 * must not surface the stale onboarding blob as their identity.
 */
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

let currentUserRow: Record<string, unknown> | null = null;

function tableMock() {
  return (table: string) => {
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'deal-1', name: 'Nino Burgers', stage: 'INITIAL_REVIEW', status: 'ACTIVE', organizationId: 'org-1', company: null, teamMembers: [] }, error: null }) }) }) };
    }
    if (table === 'User') {
      return {
        select: () => ({
          eq: () => ({ order: async () => ({ data: [] }), single: async () => ({ data: currentUserRow }) }),
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
      return { insert: async () => ({ error: null }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-chat-ai.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'auth-ganesh' }; next(); });
  app.use('/api/deals', router);
  return app;
}

async function sentDealContext(): Promise<string> {
  runDealChatAgent.mockResolvedValue({ response: 'ok', model: 'test' });
  const app = await buildApp();
  await request(app).post('/api/deals/deal-1/chat').send({ message: 'hii' });
  expect(runDealChatAgent).toHaveBeenCalledTimes(1);
  return runDealChatAgent.mock.calls[0][0].dealContext as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSupabase.from.mockImplementation(tableMock());
  delete process.env.DEAL_CHAT_ENGINE;
});

describe('deal chat — current user identity', () => {
  it('identifies the user by their Settings name and title', async () => {
    currentUserRow = { name: 'Ganesh Jagtap', title: 'Associate', onboardingStatus: {} };
    const ctx = await sentDealContext();
    expect(ctx).toContain('Ganesh Jagtap');
    expect(ctx).toContain('Associate');
  });

  it('never presents the stale onboarding research blob as the user identity', async () => {
    currentUserRow = {
      name: 'Ganesh Jagtap',
      title: 'Associate',
      onboardingStatus: { personProfile: { title: 'Dev Shah', bio: 'Founder of Pocket Fund' } },
    };
    const ctx = await sentDealContext();
    expect(ctx).toContain('Ganesh Jagtap');
    expect(ctx).not.toContain('Dev Shah');
    expect(ctx).not.toContain('Founder of Pocket Fund');
  });

  it('adds no identity line when the user row cannot be loaded', async () => {
    currentUserRow = null;
    const ctx = await sentDealContext();
    expect(ctx).not.toMatch(/You are assisting/i);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const unwrap = vi.fn();
const retrieve = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  getAnthropicClient: () => ({
    beta: { webhooks: { unwrap }, sessions: { retrieve } },
  }),
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/managed-agents-webhooks.js');
  const app = express();
  app.use('/api/webhooks/managed-agents', express.raw({ type: 'application/json' }), router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/managed-agents', () => {
  it('rejects a payload with an invalid signature', async () => {
    unwrap.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const app = await buildApp();

    const res = await request(app).post('/api/webhooks/managed-agents').send(Buffer.from('{}'));
    expect(res.status).toBe(400);
  });

  it('marks researchStatus failed on session.status_terminated with an errored session', async () => {
    unwrap.mockReturnValue({ data: { type: 'session.status_terminated', id: 'sesn_1' } });
    retrieve.mockResolvedValue({
      id: 'sesn_1',
      status: 'terminated',
      metadata: { organizationId: 'org-1' },
      error: { message: 'sandbox crashed' },
    });
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: { researchStatus: 'running' } }, error: null }) }) }),
      update: (payload: any) => {
        updatedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));
    const app = await buildApp();

    const res = await request(app).post('/api/webhooks/managed-agents').send(Buffer.from('{}'));
    expect(res.status).toBe(204);
    expect(updatedSettings).toMatchObject({ researchStatus: 'failed', researchError: 'sandbox crashed' });
  });

  it('ignores event types it does not handle', async () => {
    unwrap.mockReturnValue({ data: { type: 'agent.updated', id: 'agent_1' } });
    const app = await buildApp();

    const res = await request(app).post('/api/webhooks/managed-agents').send(Buffer.from('{}'));
    expect(res.status).toBe(204);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});

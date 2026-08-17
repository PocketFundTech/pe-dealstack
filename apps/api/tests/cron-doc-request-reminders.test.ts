/**
 * Nightly document-request reminder sweep — POST /api/cron/doc-request-reminders.
 * Spec §3.9. Auth is the shared CRON_SECRET, same as cron-signal-scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendDocRequestEmail = vi.fn(async () => true);
vi.mock('../src/services/docRequestEmail.js', () => ({
  sendDocRequestEmail: (...args: any[]) => sendDocRequestEmail(...args),
}));

let candidates: any[] = [];
let items: any[] = [];
let deals: any[] = [];
let orgs: any[] = [];
const patches: any[] = [];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function tableMock() {
  return (table: string) => {
    if (table === 'DocRequest') {
      const chain: any = {
        select: () => chain,
        in: () => chain,
        is: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => ({ data: candidates, error: null }),
        then: (resolve: any) => resolve({ data: candidates, error: null }),
        update: (patch: any) => {
          const upd: any = { eq: (_c: string, v: string) => { patches.push({ id: v, patch }); return upd; }, then: (r: any) => r({ error: null }) };
          return upd;
        },
      };
      return chain;
    }
    if (table === 'DocRequestItem') {
      return { select: () => ({ in: () => ({ order: async () => ({ data: items, error: null }) }) }) };
    }
    if (table === 'Deal') {
      return { select: () => ({ in: async () => ({ data: deals, error: null }) }) };
    }
    if (table === 'Organization') {
      return { select: () => ({ in: async () => ({ data: orgs, error: null }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-doc-request-reminders.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/doc-request-reminders', router);
  return app;
}

function openRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1', dealId: 'deal-1', organizationId: 'org-1', token: 'tok1',
    recipientEmail: 'broker@example.com', recipientName: 'Dana', message: null,
    status: 'OPEN', createdAt: daysAgo(10), expiresAt: null, revokedAt: null,
    lastRemindedAt: null, reminderCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  patches.length = 0;
  candidates = [openRequest()];
  items = [{ requestId: 'req-1', label: 'P&L', required: true, fulfilledAt: null }];
  deals = [{ id: 'deal-1', name: 'Project Neptune' }];
  orgs = [{ id: 'org-1', name: 'Acme Capital' }];
  mockSupabase.from.mockImplementation(tableMock());
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/doc-request-reminders', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/cron/doc-request-reminders');
    expect(res.status).toBe(401);
    expect(sendDocRequestEmail).not.toHaveBeenCalled();
  });

  it('401s with the wrong cron secret', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('nudges a due request and stamps the reminder', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.reminded).toBe(1);
    expect(sendDocRequestEmail).toHaveBeenCalledTimes(1);
    expect(sendDocRequestEmail.mock.calls[0][0]).toMatchObject({
      to: 'broker@example.com',
      dealName: 'Project Neptune',
      firmName: 'Acme Capital',
      isReminder: true,
    });
    expect(patches[0].patch.reminderCount).toBe(1);
    expect(patches[0].patch.lastRemindedAt).toBeTruthy();
  });

  it('skips requests that are not yet due', async () => {
    candidates = [openRequest({ createdAt: daysAgo(1) })];
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer test-secret');

    expect(res.body.reminded).toBe(0);
    expect(sendDocRequestEmail).not.toHaveBeenCalled();
    expect(patches).toHaveLength(0);
  });

  it('stops at the reminder cap', async () => {
    candidates = [openRequest({ reminderCount: 3, lastRemindedAt: daysAgo(30) })];
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer test-secret');

    expect(res.body.reminded).toBe(0);
    expect(sendDocRequestEmail).not.toHaveBeenCalled();
  });

  it('only chases outstanding items, not ones already received', async () => {
    items = [
      { requestId: 'req-1', label: 'P&L', required: true, fulfilledAt: daysAgo(2) },
      { requestId: 'req-1', label: 'Balance sheet', required: true, fulfilledAt: null },
    ];
    candidates = [openRequest({ status: 'PARTIAL' })];
    const app = await buildApp();
    await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer test-secret');

    const sent = sendDocRequestEmail.mock.calls[0][0] as any;
    expect(sent.items.filter((i: any) => !i.fulfilledAt)).toHaveLength(1);
  });

  it('keeps going when one email fails', async () => {
    candidates = [openRequest(), openRequest({ id: 'req-2', token: 'tok2' })];
    items = [
      { requestId: 'req-1', label: 'P&L', required: true, fulfilledAt: null },
      { requestId: 'req-2', label: 'P&L', required: true, fulfilledAt: null },
    ];
    sendDocRequestEmail.mockRejectedValueOnce(new Error('resend down'));

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/doc-request-reminders')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.reminded).toBe(1);
    expect(res.body.failed).toBe(1);
  });
});

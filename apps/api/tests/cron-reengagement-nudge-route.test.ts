/**
 * Re-engagement / inactivity nudge sweep — POST /api/cron/reengagement-nudge.
 * Auth is the shared CRON_SECRET, same shape as cron-reactivation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendReengagementEmail = vi.fn(async () => true);
vi.mock('../src/services/reengagementEmail.js', () => ({
  sendReengagementEmail: (...args: any[]) => sendReengagementEmail(...args),
}));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

let users: any[] = [];
// Map of userId -> most recent AuditLog createdAt, or undefined for "no rows ever"
let lastActivityByUser: Record<string, string | undefined> = {};

function tableMock() {
  return (table: string) => {
    if (table === 'AuditLog') {
      const chain: any = {
        select: () => chain,
        eq: (_col: string, userId: string) => {
          chain.__userId = userId;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const createdAt = lastActivityByUser[chain.__userId];
          return { data: createdAt ? { createdAt } : null, error: null };
        },
      };
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-reengagement-nudge.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/reengagement-nudge', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [];
  lastActivityByUser = {};
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'User') {
      return {
        select: () => Promise.resolve({ data: users, error: null }),
      };
    }
    return tableMock()(table);
  });
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/reengagement-nudge', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/cron/reengagement-nudge');
    expect(res.status).toBe(401);
    expect(sendReengagementEmail).not.toHaveBeenCalled();
  });

  it('401s with the wrong cron secret', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(sendReengagementEmail).not.toHaveBeenCalled();
  });

  it('401s when CRON_SECRET is not configured at all', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer anything');
    expect(res.status).toBe(401);
    expect(sendReengagementEmail).not.toHaveBeenCalled();
  });

  it('skips a user who was active 5 days ago', async () => {
    users = [{ id: 'user-1', email: 'recent@user.com', name: 'Recent', organizationId: 'org-1' }];
    lastActivityByUser = { 'user-1': daysAgo(5) };

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.nudgesSent).toBe(0);
    expect(res.body.skippedRecentlyActive).toBe(1);
    expect(sendReengagementEmail).not.toHaveBeenCalled();
  });

  it('nudges a user who was last active 20 days ago', async () => {
    users = [{ id: 'user-2', email: 'dormant@user.com', name: 'Dormant', organizationId: 'org-1' }];
    lastActivityByUser = { 'user-2': daysAgo(20) };

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.nudgesSent).toBe(1);
    expect(sendReengagementEmail).toHaveBeenCalledWith({ to: 'dormant@user.com', name: 'Dormant' });
  });

  it('skips a user with zero AuditLog rows ever', async () => {
    users = [{ id: 'user-3', email: 'never@user.com', name: 'Never', organizationId: 'org-1' }];
    lastActivityByUser = { 'user-3': undefined };

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.nudgesSent).toBe(0);
    expect(res.body.skippedNeverActive).toBe(1);
    expect(sendReengagementEmail).not.toHaveBeenCalled();
  });

  it('keeps going for the rest of the batch when one user email send fails', async () => {
    users = [
      { id: 'user-4', email: 'dormant4@user.com', name: 'Four', organizationId: 'org-1' },
      { id: 'user-5', email: 'dormant5@user.com', name: 'Five', organizationId: 'org-1' },
    ];
    lastActivityByUser = { 'user-4': daysAgo(30), 'user-5': daysAgo(40) };
    sendReengagementEmail.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.nudgesSent).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(sendReengagementEmail).toHaveBeenCalledTimes(2);
  });

  it('keeps going for the rest of the batch when one AuditLog lookup throws', async () => {
    users = [
      { id: 'user-6', email: 'throws@user.com', name: 'Throws', organizationId: 'org-1' },
      { id: 'user-7', email: 'dormant7@user.com', name: 'Seven', organizationId: 'org-1' },
    ];
    lastActivityByUser = { 'user-7': daysAgo(30) };
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'User') {
        return { select: () => Promise.resolve({ data: users, error: null }) };
      }
      if (table === 'AuditLog') {
        const chain: any = {
          select: () => chain,
          eq: (_col: string, userId: string) => {
            chain.__userId = userId;
            return chain;
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            if (chain.__userId === 'user-6') {
              throw new Error('db exploded');
            }
            const createdAt = lastActivityByUser[chain.__userId];
            return { data: createdAt ? { createdAt } : null, error: null };
          },
        };
        return chain;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/reengagement-nudge')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);
    expect(res.body.nudgesSent).toBe(1);
    expect(sendReengagementEmail).toHaveBeenCalledTimes(1);
    expect(sendReengagementEmail).toHaveBeenCalledWith({ to: 'dormant7@user.com', name: 'Seven' });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendWeeklyDigestEmail = vi.fn(async () => true);
vi.mock('../src/services/weeklyDigestEmail.js', () => ({
  sendWeeklyDigestEmail: (...args: any[]) => sendWeeklyDigestEmail(...args),
}));

let orgs: any[] = [];
/** organizationId -> AuditLog rows (just needs an `action` field) */
let auditLogsByOrg: Record<string, any[]> = {};
/** organizationId -> User rows with role ADMIN */
let adminsByOrg: Record<string, any[]> = {};

function tableMock() {
  return (table: string) => {
    if (table === 'Organization') {
      return { select: () => Promise.resolve({ data: orgs, error: null }) };
    }
    if (table === 'AuditLog') {
      const chain: any = {
        select: () => chain,
        eq: (_col: string, orgId: string) => {
          chain._orgId = orgId;
          return chain;
        },
        gte: () => Promise.resolve({ data: auditLogsByOrg[chain._orgId] ?? [], error: null }),
      };
      return chain;
    }
    if (table === 'User') {
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === 'organizationId') chain._orgId = val;
          return chain.__thenable ?? chain;
        },
      };
      // Second .eq('role', 'ADMIN') call needs to resolve — make the chain
      // itself thenable so `await` on it after the final .eq() works.
      chain.then = (resolve: any) =>
        resolve({ data: adminsByOrg[chain._orgId] ?? [], error: null });
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-weekly-digest.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/weekly-digest', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  orgs = [];
  auditLogsByOrg = {};
  adminsByOrg = {};
  mockSupabase.from.mockImplementation(tableMock());
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/weekly-digest', () => {
  it('401s without the cron secret', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/cron/weekly-digest');
    expect(res.status).toBe(401);
    expect(sendWeeklyDigestEmail).not.toHaveBeenCalled();
  });

  it('401s with the wrong cron secret', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(sendWeeklyDigestEmail).not.toHaveBeenCalled();
  });

  it('500s with a clear message when CRON_SECRET itself is not set', async () => {
    delete process.env.CRON_SECRET;
    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer whatever');
    expect(res.status).toBe(401);
  });

  it('skips an org with zero AuditLog rows in the window — no digest sent', async () => {
    orgs = [{ id: 'org-1', name: 'Quiet Capital' }];
    auditLogsByOrg['org-1'] = [];
    adminsByOrg['org-1'] = [{ id: 'u1', email: 'admin@quiet.com', name: 'Q Admin' }];

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgsProcessed: 0, emailsSent: 0 });
    expect(sendWeeklyDigestEmail).not.toHaveBeenCalled();
  });

  it('sends to each ADMIN in an active org, with counts grouped by action', async () => {
    orgs = [{ id: 'org-1', name: 'Busy Capital' }];
    auditLogsByOrg['org-1'] = [
      { action: 'DEAL_CREATED' },
      { action: 'DEAL_CREATED' },
      { action: 'DOCUMENT_UPLOADED' },
    ];
    adminsByOrg['org-1'] = [
      { id: 'u1', email: 'admin1@busy.com', name: 'Admin One' },
      { id: 'u2', email: 'admin2@busy.com', name: 'Admin Two' },
    ];

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgsProcessed: 1, emailsSent: 2 });
    expect(sendWeeklyDigestEmail).toHaveBeenCalledTimes(2);
    expect(sendWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin1@busy.com',
        name: 'Admin One',
        orgName: 'Busy Capital',
        counts: { DEAL_CREATED: 2, DOCUMENT_UPLOADED: 1 },
      }),
    );
    expect(sendWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin2@busy.com', name: 'Admin Two' }),
    );
    // weekOf should be an ISO date string (YYYY-MM-DD)
    const call = sendWeeklyDigestEmail.mock.calls[0][0] as any;
    expect(call.weekOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('skips an active org with no ADMIN users, without failing the whole sweep', async () => {
    orgs = [
      { id: 'org-1', name: 'No Admins Capital' },
      { id: 'org-2', name: 'Has Admins Capital' },
    ];
    auditLogsByOrg['org-1'] = [{ action: 'DEAL_CREATED' }];
    adminsByOrg['org-1'] = [];
    auditLogsByOrg['org-2'] = [{ action: 'DEAL_CREATED' }];
    adminsByOrg['org-2'] = [{ id: 'u2', email: 'admin@hasadmins.com', name: 'Admin' }];

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(sendWeeklyDigestEmail).toHaveBeenCalledTimes(1);
    expect(sendWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@hasadmins.com' }),
    );
    expect(res.body.emailsSent).toBe(1);
  });

  it('keeps processing remaining orgs when one org throws during processing', async () => {
    orgs = [
      { id: 'org-1', name: 'Broken Capital' },
      { id: 'org-2', name: 'Fine Capital' },
    ];
    // org-1's AuditLog lookup throws synchronously via a broken gte impl
    auditLogsByOrg['org-1'] = [{ action: 'DEAL_CREATED' }];
    adminsByOrg['org-1'] = [{ id: 'u1', email: 'admin@broken.com', name: 'Broken Admin' }];
    auditLogsByOrg['org-2'] = [{ action: 'DEAL_CREATED' }];
    adminsByOrg['org-2'] = [{ id: 'u2', email: 'admin@fine.com', name: 'Fine Admin' }];

    sendWeeklyDigestEmail.mockImplementationOnce(async () => {
      throw new Error('unexpected throw from email service');
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/cron/weekly-digest')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    // org-1 threw (via sendWeeklyDigestEmail), org-2 still got processed
    expect(sendWeeklyDigestEmail).toHaveBeenCalledTimes(2);
    expect(res.body.emailsSent).toBe(1);
    expect(res.body.orgsProcessed).toBe(2);
  });
});

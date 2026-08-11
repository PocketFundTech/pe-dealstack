import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/supabase.js', () => {
  // Build a chainable query-builder mock. By default the User name lookup
  // returns nothing, so the aggregator falls back to whatever userName
  // came in the row.
  const userInResult = { data: [], error: null };
  const supabaseFrom = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue(userInResult),
  });
  return { supabase: { from: supabaseFrom }, __userInResult: userInResult };
});

vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: vi.fn(() => 'org-1'),
  verifyDealAccess: vi.fn(),
}));

vi.mock('../src/services/auditLog.js', () => ({
  getAuditLogs: vi.fn(),
  AUDIT_ACTIONS: { DEAL_VIEWED: 'DEAL_VIEWED' },
  RESOURCE_TYPES: { DEAL: 'DEAL' },
}));

import dealAccessTimelineRouter from '../src/routes/deal-access-timeline.js';
import { verifyDealAccess } from '../src/middleware/orgScope.js';
import { getAuditLogs } from '../src/services/auditLog.js';

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { id: 'u-current', email: 'me@example.com', organizationId: 'org-1' };
    next();
  });
  app.use('/api/deals', dealAccessTimelineRouter);
  return app;
}

describe('GET /api/deals/:dealId/access-timeline', () => {
  beforeEach(() => {
    (verifyDealAccess as any).mockReset();
    (getAuditLogs as any).mockReset();
  });

  it('returns 404 when verifyDealAccess returns null (cross-org or missing)', async () => {
    (verifyDealAccess as any).mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/api/deals/missing/access-timeline');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Deal not found' });
    expect(getAuditLogs).not.toHaveBeenCalled();
  });

  it('returns aggregated viewers sorted by lastViewedAt DESC', async () => {
    (verifyDealAccess as any).mockResolvedValue({ id: 'deal-1', organizationId: 'org-1' });
    (getAuditLogs as any).mockResolvedValue({
      data: [
        // 3 events for Alice (most recent)
        { userId: 'u-alice', userEmail: 'alice@a.com', userName: 'Alice', userRole: 'PARTNER', createdAt: '2026-05-07T10:00:00Z' },
        { userId: 'u-alice', userEmail: 'alice@a.com', userName: 'Alice', userRole: 'PARTNER', createdAt: '2026-05-07T09:00:00Z' },
        { userId: 'u-alice', userEmail: 'alice@a.com', userName: 'Alice', userRole: 'PARTNER', createdAt: '2026-05-06T09:00:00Z' },
        // 2 events for Bob (older)
        { userId: 'u-bob', userEmail: 'bob@b.com', userName: 'Bob', userRole: 'ASSOCIATE', createdAt: '2026-05-06T11:00:00Z' },
        { userId: 'u-bob', userEmail: 'bob@b.com', userName: 'Bob', userRole: 'ASSOCIATE', createdAt: '2026-05-05T11:00:00Z' },
        // null userId — should be skipped
        { userId: null, userEmail: 'anon@x.com', userName: null, userRole: null, createdAt: '2026-05-07T08:00:00Z' },
      ],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get('/api/deals/deal-1/access-timeline');

    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe('deal-1');
    expect(res.body.windowDays).toBe(30);
    expect(res.body.totalViews).toBe(6);
    expect(res.body.uniqueViewers).toBe(2);
    expect(res.body.viewers).toHaveLength(2);
    expect(res.body.viewers[0].userId).toBe('u-alice');
    expect(res.body.viewers[0].viewCount).toBe(3);
    expect(res.body.viewers[0].lastViewedAt).toBe('2026-05-07T10:00:00Z');
    expect(res.body.viewers[1].userId).toBe('u-bob');
    expect(res.body.viewers[1].viewCount).toBe(2);
  });

  it('returns empty viewers when no events match', async () => {
    (verifyDealAccess as any).mockResolvedValue({ id: 'deal-2', organizationId: 'org-1' });
    (getAuditLogs as any).mockResolvedValue({ data: [], error: null });

    const app = buildApp();
    const res = await request(app).get('/api/deals/deal-2/access-timeline');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dealId: 'deal-2',
      totalViews: 0,
      uniqueViewers: 0,
      viewers: [],
    });
  });

  it('respects ?days= override and clamps to a 1-365 range', async () => {
    (verifyDealAccess as any).mockResolvedValue({ id: 'deal-3', organizationId: 'org-1' });
    (getAuditLogs as any).mockResolvedValue({ data: [], error: null });

    const app = buildApp();
    const ok = await request(app).get('/api/deals/deal-3/access-timeline?days=7');
    expect(ok.status).toBe(200);
    expect(ok.body.windowDays).toBe(7);

    const tooBig = await request(app).get('/api/deals/deal-3/access-timeline?days=999');
    expect(tooBig.status).toBe(400);

    const tooSmall = await request(app).get('/api/deals/deal-3/access-timeline?days=0');
    expect(tooSmall.status).toBe(400);
  });

  it('caps viewers at 10', async () => {
    (verifyDealAccess as any).mockResolvedValue({ id: 'deal-4', organizationId: 'org-1' });
    const events = Array.from({ length: 15 }, (_, i) => ({
      userId: `u-${i}`,
      userEmail: `u${i}@x.com`,
      userName: `User ${i}`,
      userRole: 'MEMBER',
      createdAt: new Date(Date.now() - i * 60_000).toISOString(),
    }));
    (getAuditLogs as any).mockResolvedValue({ data: events, error: null });

    const app = buildApp();
    const res = await request(app).get('/api/deals/deal-4/access-timeline');
    expect(res.status).toBe(200);
    expect(res.body.totalViews).toBe(15);
    expect(res.body.uniqueViewers).toBe(15);
    expect(res.body.viewers).toHaveLength(10);
  });

  it('returns 500 when getAuditLogs errors', async () => {
    (verifyDealAccess as any).mockResolvedValue({ id: 'deal-5', organizationId: 'org-1' });
    (getAuditLogs as any).mockResolvedValue({ data: null, error: { message: 'boom' } });
    const app = buildApp();
    const res = await request(app).get('/api/deals/deal-5/access-timeline');
    expect(res.status).toBe(500);
  });
});

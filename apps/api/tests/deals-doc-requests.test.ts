/**
 * Owner-side document requests — POST/GET/PATCH/DELETE
 * /api/deals/:dealId/doc-requests (+ /remind). Spec §3.6.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1', name: 'Project Neptune' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const sendRequestEmail = vi.fn(async () => true);
vi.mock('../src/services/docRequestEmail.js', () => ({
  sendDocRequestEmail: (...args: any[]) => sendRequestEmail(...args),
}));

let insertedRequest: any = null;
let insertedItems: any[] = [];
let insertedActivity: any = null;
let requests: any[] = [];
let items: any[] = [];
let requestPatch: any = null;
let singleRequest: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'DocRequest') {
      // .eq() is chained a variable number of times across the routes
      // (list: dealId+org; get-one/update: id+dealId+org), so the chain
      // has to be self-returning rather than a fixed nesting depth.
      const chain: any = {
        eq: () => chain,
        order: async () => ({ data: requests, error: null }),
        single: async () => ({ data: singleRequest, error: null }),
        then: (resolve: any) => resolve({ error: null }),
      };
      return {
        insert: (row: any) => {
          insertedRequest = row;
          return {
            select: () => ({ single: async () => ({ data: { id: 'req-1', ...row }, error: null }) }),
          };
        },
        select: () => chain,
        update: (patch: any) => {
          requestPatch = patch;
          return chain;
        },
      };
    }
    if (table === 'DocRequestItem') {
      return {
        insert: (rows: any[]) => {
          insertedItems = rows;
          return {
            select: async () => ({
              data: rows.map((r: any, i: number) => ({ id: `item-${i}`, ...r })),
              error: null,
            }),
          };
        },
        // list path uses .in(requestIds).order(), remind path uses .eq(id).order()
        select: () => ({
          in: () => ({ order: async () => ({ data: items, error: null }) }),
          eq: () => ({ order: async () => ({ data: items, error: null }) }),
        }),
      };
    }
    if (table === 'DocRequestEvent') {
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
    }
    if (table === 'Organization') {
      // Read for email branding ("<Firm> has requested documents").
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { name: 'Acme Capital' }, error: null }) }) }) };
    }
    if (table === 'Activity') {
      return { insert: async (row: any) => { insertedActivity = row; return { error: null }; } };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/deals-doc-requests.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1' }; next(); });
  app.use('/api/deals', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1', name: 'Project Neptune' };
  insertedRequest = null;
  insertedItems = [];
  insertedActivity = null;
  requestPatch = null;
  singleRequest = null;
  requests = [];
  items = [];
  mockSupabase.from.mockImplementation(tableMock());
  sendRequestEmail.mockResolvedValue(true);
  delete process.env.APP_URL;
});

describe('POST /api/deals/:dealId/doc-requests', () => {
  it('expands a template into items and returns an upload URL with a 64-hex token', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/doc-requests')
      .send({ templateKey: 'FINANCIALS_ONLY', recipientEmail: 'broker@example.com' });

    expect(res.status).toBe(201);
    expect(insertedRequest.token).toMatch(/^[0-9a-f]{64}$/);
    expect(insertedRequest.organizationId).toBe('org-1');
    expect(insertedItems.length).toBe(6);
    expect(insertedItems[0].label).toBe('3-year P&L');
    expect(res.body.url).toBe(`http://localhost:3002/upload/${insertedRequest.token}`);
  });

  it('accepts an explicit item list and preserves its order', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/doc-requests')
      .send({ items: [{ label: 'Cap table' }, { label: 'Customer list', required: false }] });

    expect(res.status).toBe(201);
    expect(insertedItems.map((i: any) => i.label)).toEqual(['Cap table', 'Customer list']);
    expect(insertedItems.map((i: any) => i.sortOrder)).toEqual([0, 1]);
    expect(insertedItems[0].required).toBe(true);
    expect(insertedItems[1].required).toBe(false);
  });

  it('rejects a request with no checklist at all', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/doc-requests').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown template key', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/doc-requests')
      .send({ templateKey: 'NOT_A_TEMPLATE' });
    expect(res.status).toBe(400);
  });

  it('404s when the deal belongs to another org', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-x/doc-requests')
      .send({ templateKey: 'FINANCIALS_ONLY' });

    expect(res.status).toBe(404);
    expect(insertedRequest).toBeNull();
  });

  it('emails the recipient when one is given', async () => {
    const app = await buildApp();
    await request(app)
      .post('/api/deals/deal-1/doc-requests')
      .send({ templateKey: 'FINANCIALS_ONLY', recipientEmail: 'broker@example.com', message: 'Thanks!' });

    expect(sendRequestEmail).toHaveBeenCalledTimes(1);
    expect(sendRequestEmail.mock.calls[0][0]).toMatchObject({
      to: 'broker@example.com',
      dealName: 'Project Neptune',
    });
  });

  it('does not email when no recipient is given', async () => {
    const app = await buildApp();
    await request(app).post('/api/deals/deal-1/doc-requests').send({ templateKey: 'FINANCIALS_ONLY' });
    expect(sendRequestEmail).not.toHaveBeenCalled();
  });

  it('logs deal activity so the request shows on the timeline', async () => {
    const app = await buildApp();
    await request(app).post('/api/deals/deal-1/doc-requests').send({ templateKey: 'FINANCIALS_ONLY' });
    expect(insertedActivity).toMatchObject({ dealId: 'deal-1' });
  });
});

describe('GET /api/deals/:dealId/doc-requests/templates', () => {
  it('serves the checklist templates so the modal edits a server-owned list', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/doc-requests/templates');

    expect(res.status).toBe(200);
    expect(res.body.templates.STANDARD_DD[0]).toMatchObject({ label: '3-year P&L', sortOrder: 0 });
    expect(Object.keys(res.body.templates)).toContain('QOE_PREP');
  });

  it('does not get swallowed by the /:id route below it', async () => {
    // 'templates' must not be read as a request id — mount order regression.
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/doc-requests/templates');
    expect(res.body.templates).toBeDefined();
  });
});

describe('GET /api/deals/:dealId/doc-requests', () => {
  it('returns each request with its items and a received/total count', async () => {
    requests = [
      { id: 'req-1', token: 'tok1', status: 'PARTIAL', recipientEmail: 'b@x.com', createdAt: '2026-08-01T00:00:00Z', expiresAt: null, revokedAt: null, message: null, recipientName: null, reminderCount: 0, lastRemindedAt: null, completedAt: null },
    ];
    items = [
      { id: 'i1', requestId: 'req-1', label: 'P&L', required: true, sortOrder: 0, fulfilledAt: '2026-08-02T00:00:00Z', documentId: 'doc-1', docType: 'FINANCIALS', notes: null },
      { id: 'i2', requestId: 'req-1', label: 'Balance sheet', required: true, sortOrder: 1, fulfilledAt: null, documentId: null, docType: 'FINANCIALS', notes: null },
    ];

    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/doc-requests');

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].items).toHaveLength(2);
    expect(res.body.requests[0].receivedCount).toBe(1);
    expect(res.body.requests[0].totalCount).toBe(2);
    expect(res.body.requests[0].url).toContain('/upload/tok1');
  });

  it('404s across orgs', async () => {
    dealAccess = null;
    const app = await buildApp();
    expect((await request(app).get('/api/deals/deal-x/doc-requests')).status).toBe(404);
  });
});

describe('DELETE /api/deals/:dealId/doc-requests/:id', () => {
  it('soft-revokes rather than deleting the audit trail', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/api/deals/deal-1/doc-requests/req-1');

    expect(res.status).toBe(200);
    expect(requestPatch.revokedAt).toBeTruthy();
    expect(requestPatch.status).toBe('CANCELLED');
  });
});

describe('POST /api/deals/:dealId/doc-requests/:id/remind', () => {
  it('re-sends and stamps the reminder', async () => {
    singleRequest = {
      id: 'req-1', token: 'tok1', status: 'OPEN', recipientEmail: 'b@x.com',
      recipientName: null, message: null, createdAt: '2026-08-01T00:00:00Z',
      expiresAt: null, revokedAt: null, lastRemindedAt: null, reminderCount: 0,
    };
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/doc-requests/req-1/remind');

    expect(res.status).toBe(200);
    expect(sendRequestEmail).toHaveBeenCalledTimes(1);
    expect(requestPatch.reminderCount).toBe(1);
    expect(requestPatch.lastRemindedAt).toBeTruthy();
  });

  it('429s when the last reminder went out under a day ago', async () => {
    singleRequest = {
      id: 'req-1', token: 'tok1', status: 'OPEN', recipientEmail: 'b@x.com',
      recipientName: null, message: null, createdAt: '2026-08-01T00:00:00Z',
      expiresAt: null, revokedAt: null,
      lastRemindedAt: new Date(Date.now() - 3600_000).toISOString(), reminderCount: 1,
    };
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/doc-requests/req-1/remind');

    expect(res.status).toBe(429);
    expect(sendRequestEmail).not.toHaveBeenCalled();
  });

  it('400s when there is no recipient to remind', async () => {
    singleRequest = {
      id: 'req-1', token: 'tok1', status: 'OPEN', recipientEmail: null,
      recipientName: null, message: null, createdAt: '2026-08-01T00:00:00Z',
      expiresAt: null, revokedAt: null, lastRemindedAt: null, reminderCount: 0,
    };
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/doc-requests/req-1/remind');

    expect(res.status).toBe(400);
    expect(sendRequestEmail).not.toHaveBeenCalled();
  });
});

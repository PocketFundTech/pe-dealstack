/**
 * Outbound webhooks: signing, delivery bookkeeping, and the management API's
 * guards (admin-only, https-only, no private networks, secret shown once).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';

const { db } = vi.hoisted(() => ({
  db: {
    updates: [] as Record<string, unknown>[],
    inserted: null as Record<string, unknown> | null,
    subs: [] as Record<string, unknown>[],
  },
}));

vi.mock('../src/supabase.js', () => {
  const from = (table: string) => {
    const chain: Record<string, any> = {};
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.contains = () => chain;
    chain.order = () => chain;
    chain.update = (u: Record<string, unknown>) => { op = 'update'; payload = u; db.updates.push(u); return chain; };
    chain.insert = (row: Record<string, unknown>) => { op = 'insert'; payload = row; db.inserted = row; return chain; };
    chain.single = async () => {
      if (table === 'User') return { data: { id: 'user-row-1' }, error: null };
      if (op === 'insert') return { data: { id: 'wh-1', ...payload, secret: undefined }, error: null };
      return { data: null, error: null };
    };
    chain.maybeSingle = async () => ({ data: db.subs[0] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve(op === 'update' ? { error: null } : { data: db.subs, error: null });
    return chain;
  };
  return { supabase: { from } };
});
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock('../src/services/safeHttpPost.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/safeHttpPost.js')>('../src/services/safeHttpPost.js');
  return { ...actual, safePostJson: postMock };
});
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { deliverWebhook, signWebhookPayload, generateWebhookSecret } from '../src/services/outboundWebhooks.js';
import router from '../src/routes/webhook-subscriptions.js';

function app(role = 'ADMIN') {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: 'auth-1', role, organizationId: 'org-1' }; next(); });
  a.use('/api/webhook-subscriptions', router);
  return a;
}

const fetchMock = postMock;
beforeEach(() => {
  db.updates = []; db.inserted = null; db.subs = [];
  postMock.mockReset();
});

describe('webhook signing', () => {
  it('secrets use the whsec_ prefix and are random', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);
    expect(generateWebhookSecret()).not.toBe(s);
  });

  it('signs `${timestamp}.${body}` with HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'whsec_x').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhookPayload('whsec_x', 1700000000, '{"a":1}')).toBe(expected);
  });
});

describe('deliverWebhook', () => {
  const sub = { id: 'wh-1', url: 'https://hooks.example.com/avise', secret: 'whsec_test', failureCount: 2 };

  it('POSTs a signed JSON envelope and resets the failure count on 2xx', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const result = await deliverWebhook(sub, 'deal.created', 'org-1', { id: 'deal-1' });

    expect(result).toEqual({ ok: true, status: 200, error: undefined });
    const [url, headers, rawBody] = fetchMock.mock.calls[0];
    expect(url).toBe(sub.url);
    const body = JSON.parse(rawBody);
    expect(body).toMatchObject({ event: 'deal.created', organizationId: 'org-1', data: { id: 'deal-1' } });
    expect(headers['Avise-Event']).toBe('deal.created');
    const [, t, v1] = headers['Avise-Signature'].match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(v1).toBe(signWebhookPayload(sub.secret, Number(t), rawBody));
    expect(db.updates.at(-1)).toMatchObject({ lastStatus: 200, failureCount: 0, lastError: null });
  });

  it('records a non-2xx answer as a failure with a readable reason', async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const result = await deliverWebhook(sub, 'deal.updated', 'org-1', {});
    expect(result.ok).toBe(false);
    expect(db.updates.at(-1)).toMatchObject({ lastStatus: 500, failureCount: 3, lastError: 'Receiver answered HTTP 500' });
  });

  it('records an unreachable URL without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const result = await deliverWebhook(sub, 'deal.updated', 'org-1', {});
    expect(result).toMatchObject({ ok: false, status: 0 });
    expect(db.updates.at(-1)).toMatchObject({ lastStatus: null, failureCount: 3 });
    expect(String(db.updates.at(-1)?.lastError)).toContain('Could not reach the URL');
  });

  it('reports a URL that resolves to a private address as blocked', async () => {
    const { BlockedAddressError } = await import('../src/services/safeHttpPost.js');
    fetchMock.mockRejectedValue(new BlockedAddressError('evil.example resolves to a private or internal address'));
    await deliverWebhook(sub, 'deal.updated', 'org-1', {});
    expect(String(db.updates.at(-1)?.lastError)).toMatch(/^Blocked: /);
  });

  it('pauses the subscription after 20 failures in a row', async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    await deliverWebhook({ ...sub, failureCount: 19 }, 'deal.updated', 'org-1', {});
    expect(db.updates.at(-1)).toMatchObject({ failureCount: 20, active: false });
  });

  it('strips document text and nested collections from the payload', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    await deliverWebhook(sub, 'deal.updated', 'org-1', {
      id: 'deal-1', name: 'Falcon', documents: [{ extractedText: 'x'.repeat(1000) }], activities: [{}], extractedText: 'big',
    });
    const data = JSON.parse(fetchMock.mock.calls[0][2]).data;
    expect(data).toEqual({ id: 'deal-1', name: 'Falcon' });
  });
});

describe('/api/webhook-subscriptions', () => {
  it('lists the supported events', async () => {
    const res = await request(app()).get('/api/webhook-subscriptions/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toContain('deal.stage_changed');
  });

  it('rejects non-admins', async () => {
    const res = await request(app('MEMBER')).get('/api/webhook-subscriptions');
    expect(res.status).toBe(403);
  });

  it('creates a subscription and returns the secret once', async () => {
    const res = await request(app())
      .post('/api/webhook-subscriptions')
      .send({ url: 'https://hooks.example.com/avise', events: ['deal.created', 'deal.created', 'document.uploaded'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(db.inserted).toMatchObject({ organizationId: 'org-1', events: ['deal.created', 'document.uploaded'] });
  });

  it.each([
    ['plain http', { url: 'http://hooks.example.com/x', events: ['deal.created'] }, 'https'],
    ['a private network', { url: 'https://192.168.1.10/x', events: ['deal.created'] }, 'private'],
    ['no events', { url: 'https://hooks.example.com/x', events: [] }, 'at least one'],
    ['an unknown event', { url: 'https://hooks.example.com/x', events: ['deal.exploded'] }, ''],
  ])('refuses %s', async (_label, body, msg) => {
    const res = await request(app()).post('/api/webhook-subscriptions').send(body);
    expect(res.status).toBe(400);
    expect(String(res.body.error).toLowerCase()).toContain(msg);
    expect(db.inserted).toBeNull();
  });

  it('test-sends a ping and reports the receiver status', async () => {
    db.subs = [{ id: '11111111-1111-1111-1111-111111111111', url: 'https://hooks.example.com/x', secret: 'whsec_t', failureCount: 0 }];
    fetchMock.mockResolvedValue({ status: 204 });
    const res = await request(app()).post('/api/webhook-subscriptions/11111111-1111-1111-1111-111111111111/test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 204 });
    expect(JSON.parse(fetchMock.mock.calls[0][2]).event).toBe('ping');
  });

  it('404s an unknown id without touching the database', async () => {
    const res = await request(app()).delete('/api/webhook-subscriptions/not-a-uuid');
    expect(res.status).toBe(404);
  });
});

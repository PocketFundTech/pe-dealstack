/**
 * QA #11 (1 Oct 2026): Settings → Active sessions showed nothing — the list
 * silently came back empty and the current device was never flagged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let rpcResult: { data: any; error: any } = { data: null, error: { code: 'PGRST202', message: 'not found' } };
let schemaResult: { data: any; error: any } = { data: null, error: { code: 'PGRST106', message: 'schema not exposed' } };
vi.mock('../src/supabase.js', () => ({
  supabase: {
    rpc: async () => rpcResult,
    auth: { admin: {} },
    schema: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: async () => schemaResult }) }) }) }),
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/services/auditLog.js', () => ({ logAuditEvent: async () => {}, AUDIT_ACTIONS: {}, RESOURCE_TYPES: {}, SEVERITY: {} }));

const { sessionIdFromJwt } = await import('../src/middleware/auth.js');
const { default: router } = await import('../src/routes/auth-sessions.js');

function app(sessionId?: string) {
  const a = express();
  a.use((req: any, _r, next) => { req.user = { id: 'auth-uid' }; req.sessionId = sessionId; next(); });
  a.use('/api/auth', router);
  return a;
}

beforeEach(() => {
  rpcResult = { data: null, error: { code: 'PGRST202', message: 'not found' } };
  schemaResult = { data: null, error: { code: 'PGRST106', message: 'schema not exposed' } };
});

describe('GET /api/auth/sessions', () => {
  it('says unavailable (501) instead of an empty list when sessions cannot be read', async () => {
    const res = await request(app()).get('/api/auth/sessions');
    expect(res.status).toBe(501);
  });

  it('reads sessions through the RPC and flags the current one', async () => {
    rpcResult = {
      data: [
        { id: 's-current', created_at: '2026-10-02T08:00:00Z', updated_at: '2026-10-02T09:00:00Z', user_agent: 'Chrome', ip: '1.2.3.4' },
        { id: 's-other', created_at: '2026-10-01T08:00:00Z', updated_at: null, user_agent: 'Safari', ip: '5.6.7.8' },
      ],
      error: null,
    };
    const res = await request(app('s-current')).get('/api/auth/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions.map((s: any) => [s.id, s.current])).toEqual([['s-current', true], ['s-other', false]]);
  });
});

describe('sessionIdFromJwt', () => {
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  it('reads the session_id claim', () => {
    expect(sessionIdFromJwt(jwt({ sub: 'u', session_id: 'abc-123' }))).toBe('abc-123');
  });
  it('is undefined for tokens without the claim or garbage', () => {
    expect(sessionIdFromJwt(jwt({ sub: 'u' }))).toBeUndefined();
    expect(sessionIdFromJwt('not-a-jwt')).toBeUndefined();
  });
});

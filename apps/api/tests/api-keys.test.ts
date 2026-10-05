/**
 * API key auth: format, hashing, and which keys authMiddleware accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { maybeSingle, getUser } = vi.hoisted(() => ({ maybeSingle: vi.fn(), getUser: vi.fn() }));

vi.mock('../src/supabase.js', () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = maybeSingle;
  chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
  return { supabase: { from: () => chain, auth: { getUser } } };
});

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { authMiddleware } from '../src/middleware/auth.js';
import { generateApiKey, hashApiKey, isApiKey, resetApiKeyScopeProbe } from '../src/services/apiKeyService.js';
import { enforceApiKeyScope } from '../src/middleware/auth.js';

const ORG = '11111111-1111-1111-1111-111111111111';

function keyRow(overrides: Record<string, unknown> = {}, userOverrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    organizationId: ORG,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    user: { authId: 'auth-1', email: 'a@firm.com', name: 'Admin', role: 'ADMIN', organizationId: ORG, isActive: true, ...userOverrides },
    ...overrides,
  };
}

function ctx(headers: Record<string, string>) {
  const req = { headers, originalUrl: '/api/deals' } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetApiKeyScopeProbe();
});

describe('generateApiKey', () => {
  it('produces the standard avise_sk_ format with a matching hash and display parts', () => {
    const k = generateApiKey();
    expect(k.key).toMatch(/^avise_sk_[A-Za-z0-9_-]{43}$/);
    expect(k.keyHash).toBe(hashApiKey(k.key));
    expect(k.keyPrefix).toBe(k.key.slice(0, 13));
    expect(k.lastFour).toBe(k.key.slice(-4));
    expect(isApiKey(k.key)).toBe(true);
    expect(generateApiKey().key).not.toBe(k.key);
  });
});

describe('authMiddleware with API keys', () => {
  it('accepts a valid key via Authorization: Bearer and acts as its owner in its org', async () => {
    maybeSingle.mockResolvedValue({ data: keyRow(), error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 'auth-1', organizationId: ORG, role: 'ADMIN', apiKeyId: 'key-1' });
    expect(getUser).not.toHaveBeenCalled();
  });

  it('accepts a valid key via X-API-Key', async () => {
    maybeSingle.mockResolvedValue({ data: keyRow(), error: null });
    const { req, res, next } = ctx({ 'x-api-key': 'avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['unknown', null],
    ['revoked', keyRow({ revokedAt: '2026-01-01T00:00:00Z' })],
    ['expired', keyRow({ expiresAt: '2020-01-01T00:00:00Z' })],
    ['owner deactivated', keyRow({}, { isActive: false })],
    ['owner moved org', keyRow({}, { organizationId: '22222222-2222-2222-2222-222222222222' })],
  ])('rejects a %s key with 401', async (_label, row) => {
    maybeSingle.mockResolvedValue({ data: row, error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an X-API-Key without the avise_sk_ prefix without a DB lookup', async () => {
    const { req, res, next } = ctx({ 'x-api-key': 'sk-something-else' });
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it('still sends normal Bearer JWTs to Supabase', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u', email: 'x@y.z', user_metadata: {} } }, error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer eyJhbGciOi.jwt' });
    await authMiddleware(req, res, next);
    expect(getUser).toHaveBeenCalledWith('eyJhbGciOi.jwt');
    expect(maybeSingle).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

describe('authMiddleware carries the key\'s scope', () => {
  it('a full-access key (scope omitted, legacy rows) resolves as full', async () => {
    maybeSingle.mockResolvedValue({ data: keyRow(), error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(req.user?.apiKeyScope).toBe('full');
  });

  it('a read_only key resolves with apiKeyScope "read_only"', async () => {
    maybeSingle.mockResolvedValue({ data: keyRow({ scope: 'read_only' }), error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(req.user?.apiKeyScope).toBe('read_only');
  });

  it('falls back to full-access when the scope column does not exist yet, instead of breaking every key', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: null, error: { code: '42703', message: 'column ApiKey.scope does not exist' } })
      .mockResolvedValueOnce({ data: keyRow(), error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer avise_sk_abc' });
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user?.apiKeyScope).toBe('full');
  });

  it('a session JWT login never carries apiKeyScope', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u', email: 'x@y.z', user_metadata: {} } }, error: null });
    const { req, res, next } = ctx({ authorization: 'Bearer eyJhbGciOi.jwt' });
    await authMiddleware(req, res, next);
    expect(req.user?.apiKeyScope).toBeUndefined();
  });
});

describe('enforceApiKeyScope middleware', () => {
  function reqCtx(method: string, apiKeyScope?: 'full' | 'read_only') {
    const req = { method, user: apiKeyScope ? { id: 'u', role: 'ADMIN', apiKeyScope } : { id: 'u', role: 'ADMIN' } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const next = vi.fn() as NextFunction;
    return { req, res, next };
  }

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets a read_only key through on %s', (method) => {
    const { req, res, next } = reqCtx(method, 'read_only');
    enforceApiKeyScope(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('blocks a read_only key on %s with 403', (method) => {
    const { req, res, next } = reqCtx(method, 'read_only');
    enforceApiKeyScope(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'GET'])('never blocks a full-access key on %s', (method) => {
    const { req, res, next } = reqCtx(method, 'full');
    enforceApiKeyScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('never blocks a session login (no apiKeyScope) on %s', (method) => {
    const { req, res, next } = reqCtx(method);
    enforceApiKeyScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

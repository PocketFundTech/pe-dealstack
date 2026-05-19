/**
 * MFA Bypass Path Matching Tests (Task 5.7)
 *
 * Verifies that `enforceOrgMfaMiddleware`'s bypass list uses EXACT-path
 * matching for the leaf endpoints (`/organizations/me`, `/users/me`, plus
 * `/api` variants) rather than `startsWith()`.
 *
 * The original implementation used `startsWith(prefix)`, which meant a future
 * endpoint added under e.g. `/api/organizations/me/members` would silently
 * bypass MFA enforcement as the surface area grew — a fragile pattern this
 * task replaces with an explicit Set<string> of exact paths.
 *
 * Per-test guarantees:
 *  - `/api/organizations/me` (exact) → BYPASSES MFA (allowed pre-fix and post-fix)
 *  - `/api/organizations/me/members` (hypothetical leaf under `me`) → BLOCKED
 *    (would PASS startsWith — fails on current code, passes after fix)
 *  - `/api/organizations/me-extra` (shares prefix but unrelated path) → BLOCKED
 *  - `/api/organizations/me?foo=bar` (query string) → BYPASSES (query stripped)
 *  - `/api/organizations/me/` (trailing slash) → BYPASSES (normalized)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock supabase before importing auth middleware
vi.mock('../src/supabase.js', () => {
  // .from('Organization').select(...).eq(...).single() → { data: { requireMFA: true }, error: null }
  const singleMock = vi.fn().mockResolvedValue({
    data: { requireMFA: true },
    error: null,
  });
  const eqMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });

  return {
    supabase: {
      from: fromMock,
      auth: {
        getUser: vi.fn(),
        admin: {
          mfa: {
            // No verified factors → user is NOT MFA-enrolled
            listFactors: vi.fn().mockResolvedValue({
              data: { factors: [] },
              error: null,
            }),
          },
        },
      },
    },
  };
});

// Mock logger
vi.mock('../src/utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { enforceOrgMfaMiddleware } from '../src/middleware/auth.js';

function createCtx(originalUrl: string) {
  const req = {
    originalUrl,
    url: originalUrl,
    user: {
      id: 'user-123',
      email: 'test@example.com',
      role: 'MEMBER',
      organizationId: 'org-123', // org has requireMFA = true (from mock)
    },
  } as unknown as Request;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;

  const next = vi.fn() as NextFunction;

  return { req, res, next };
}

describe('enforceOrgMfaMiddleware bypass-path matching (Task 5.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses MFA for /api/organizations/me (exact leaf path)', async () => {
    const { req, res, next } = createCtx('/api/organizations/me');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('bypasses MFA for /api/users/me (exact leaf path)', async () => {
    const { req, res, next } = createCtx('/api/users/me');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('BLOCKS hypothetical future leaf under /api/organizations/me/* (regression for startsWith bug)', async () => {
    // Under the old startsWith() check, `/api/organizations/me/members` would
    // match `/api/organizations/me` and silently bypass MFA. After the fix,
    // exact-match means this leaf is correctly enforced.
    const { req, res, next } = createCtx('/api/organizations/me/members');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MFA_REQUIRED' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('BLOCKS path sharing the bypass prefix but not actually under it (/api/organizations/me-extra)', async () => {
    const { req, res, next } = createCtx('/api/organizations/me-extra');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('bypasses MFA for /api/organizations/me?foo=bar (query string stripped)', async () => {
    const { req, res, next } = createCtx('/api/organizations/me?foo=bar');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('bypasses MFA for /api/organizations/me/ (trailing slash normalized)', async () => {
    const { req, res, next } = createCtx('/api/organizations/me/');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('continues to bypass /api/auth/* subtree (legitimate prefix bypass for login/MFA enrollment)', async () => {
    // The /auth/ namespace is intentionally a prefix bypass so users can hit
    // /auth/sessions, /auth/login, MFA-enrollment endpoints, etc. without MFA.
    const { req, res, next } = createCtx('/api/auth/sessions');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('enforces MFA for protected endpoints like /api/deals', async () => {
    const { req, res, next } = createCtx('/api/deals');
    await enforceOrgMfaMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

/**
 * Invitations API Endpoint Tests — exercises the REAL invitationsRouter.
 *
 * Prior versions of this file used the "mini-app" pattern: an inline
 * express() app that reproduced route logic against a local mockInvitations
 * array. That meant the actual handlers in apps/api/src/routes/invitations*.ts
 * were never executed — bugs in real handlers (self-invite checks, org
 * scoping, inviteUrl decoration, token stripping for accepted/expired rows)
 * would slip through.
 *
 * This file mounts the real invitationsRouter (apps/api/src/routes/invitations.ts)
 * — which itself sub-mounts invitations-accept.ts — and exercises it via
 * supertest. Supabase + orgScope + Resend + AuditLog + notification helpers
 * + onboarding completion are all mocked (those are runtime dependencies,
 * not handler logic). The control flow of the actual handlers runs.
 *
 * The public verify/:token route doesn't require auth, so we build a separate
 * app via `buildPublicApp()` that doesn't inject `req.user`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ───── Mocks (MUST be declared before the dynamic import) ─────────

const mockSupabase = {
  from: vi.fn(),
  auth: {
    signUp: vi.fn(),
  },
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/auditLog.js', () => ({
  AuditLog: {
    log: vi.fn(),
  },
}));

vi.mock('../src/routes/notifications.js', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../src/routes/onboarding.js', () => ({
  tryCompleteOnboardingStep: vi.fn(),
}));

// orgScope helpers — getOrgId returns 'org-A' for this suite.
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
}));

// Resend module — mock at the import level so `new Resend(key)` returns
// a stub with an `emails.send` method we can assert against. Even though
// the real router only constructs Resend when RESEND_API_KEY is set, we
// mock it anyway so the test never accidentally hits real Resend if the
// env leaks in.
const resendSend = vi.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: resendSend },
  })),
}));

// Ensure RESEND_API_KEY is NOT set so the router's `null` branch runs
// and we don't construct a Resend client (the mock above is a safety net).
delete process.env.RESEND_API_KEY;

// ───── Test app builders ────────────────────────────────────────────

const buildApp = async () => {
  const { default: invitationsRouter } = await import('../src/routes/invitations.js');
  const app = express();
  app.use(express.json());
  // Fake auth — mirrors what the real authMiddleware would attach.
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'test-auth-uuid',
      organizationId: 'org-A',
      role: 'ADMIN',
      email: 'admin@testfirm.com',
    };
    next();
  });
  app.use('/api/invitations', invitationsRouter);
  return app;
};

// For the public verify/:token route — no auth middleware.
const buildPublicApp = async () => {
  const { default: invitationsRouter } = await import('../src/routes/invitations.js');
  const app = express();
  app.use(express.json());
  app.use('/api/invitations', invitationsRouter);
  return app;
};

// Build an app whose authenticated user is a MEMBER (not ADMIN). Used to
// verify the "only ADMIN can invite ADMIN" branch.
const buildMemberApp = async () => {
  const { default: invitationsRouter } = await import('../src/routes/invitations.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: 'member-auth-uuid',
      organizationId: 'org-A',
      role: 'MEMBER',
      email: 'member@testfirm.com',
    };
    next();
  });
  app.use('/api/invitations', invitationsRouter);
  return app;
};

// ───── Tests ────────────────────────────────────────────────────────

describe('Real /api/invitations handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  // ── GET /api/invitations ───────────────────────────────────────
  describe('GET /api/invitations', () => {
    it('returns invitations scoped to org and decorates inviteUrl for PENDING only', async () => {
      const rows = [
        {
          id: 'inv-1',
          email: 'pending@example.com',
          role: 'MEMBER',
          status: 'PENDING',
          firmName: 'Test Firm',
          organizationId: 'org-A',
          token: 'tok_pending_1',
          createdAt: '2026-05-01T00:00:00Z',
          expiresAt: '2026-12-01T00:00:00Z',
          acceptedAt: null,
          inviter: { id: 'u1', name: 'Admin', email: 'admin@testfirm.com', avatar: null },
        },
        {
          id: 'inv-2',
          email: 'done@example.com',
          role: 'MEMBER',
          status: 'ACCEPTED',
          firmName: 'Test Firm',
          organizationId: 'org-A',
          token: 'tok_accepted_2',
          createdAt: '2026-05-01T00:00:00Z',
          expiresAt: '2026-12-01T00:00:00Z',
          acceptedAt: '2026-05-02T00:00:00Z',
          inviter: { id: 'u1', name: 'Admin', email: 'admin@testfirm.com', avatar: null },
        },
      ];
      // Chain: from('Invitation').select(...).eq('organizationId', orgId).order('createdAt', ...)
      // Optionally .eq('status', ...) if query has status. The order() resolves the promise.
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: rows, error: null }),
            eq: () => ({
              order: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).get('/api/invitations');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);

      // PENDING row gets an inviteUrl. Token is stripped from the response.
      const pending = res.body.find((r: any) => r.id === 'inv-1');
      expect(pending.inviteUrl).toBeTruthy();
      expect(pending.inviteUrl).toContain('/accept-invite?token=tok_pending_1');
      expect(pending.token).toBeUndefined();

      // ACCEPTED row gets null inviteUrl; token is also stripped.
      const accepted = res.body.find((r: any) => r.id === 'inv-2');
      expect(accepted.inviteUrl).toBeNull();
      expect(accepted.token).toBeUndefined();
    });
  });

  // ── POST /api/invitations ──────────────────────────────────────
  describe('POST /api/invitations', () => {
    it('creates an invitation and returns inviteUrl', async () => {
      const currentUser = {
        id: 'internal-admin-1',
        name: 'Admin User',
        email: 'admin@testfirm.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'ADMIN',
      };
      const insertedInvite = {
        id: 'inv-new',
        email: 'brandnew@example.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'MEMBER',
        invitedBy: 'internal-admin-1',
        token: 'fresh-token',
        expiresAt: '2026-12-01T00:00:00Z',
        status: 'PENDING',
      };

      // Three different supabase.from() shapes are needed in sequence:
      //   1. from('User').select(...).eq('authId', user.id).maybeSingle() → currentUser
      //   2. from('Organization').select('name').eq('id', orgId).single() → { name: 'Test Firm' }
      //   3. from('User').select('id').eq('email').eq('organizationId').maybeSingle() → null (no existing user)
      //   4. from('Invitation').select('id').eq(email).eq(orgId).eq(status).maybeSingle() → null
      //   5. from('Invitation').insert({...}).select().single() → insertedInvite
      let userSelectCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'User') {
          userSelectCount++;
          // First User select = currentUser lookup; second = existing-user check
          if (userSelectCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: currentUser, error: null }),
                }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'Organization') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Firm' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'Invitation') {
          return {
            // existing-pending check
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({ data: insertedInvite, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'brandnew@example.com', role: 'MEMBER' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('inv-new');
      expect(res.body.email).toBe('brandnew@example.com');
      // The handler builds inviteUrl from a freshly-generated 32-byte
      // hex token via crypto.randomBytes — assert shape, not literal value.
      expect(res.body.inviteUrl).toMatch(/\/accept-invite\?token=[a-f0-9]{64}$/);
      // emailSent === false because RESEND_API_KEY is unset → null Resend branch.
      expect(res.body.emailSent).toBe(false);
    });

    it('returns 400 on Zod validation error (bad email)', async () => {
      // Validation fires before any supabase call.
      const app = await buildApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'not-an-email', role: 'MEMBER' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 INVITE_SELF when inviting your own email (req.user.email)', async () => {
      // Self-invite check fires before any supabase lookup. The authenticated
      // user's email is 'admin@testfirm.com' (set in buildApp).
      const app = await buildApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'admin@testfirm.com', role: 'MEMBER' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITE_SELF');
    });

    it('returns 403 when a non-ADMIN tries to invite an ADMIN', async () => {
      const memberUser = {
        id: 'internal-member-1',
        name: 'Member User',
        email: 'member@testfirm.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'MEMBER',
      };
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'User') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: memberUser, error: null }),
              }),
            }),
          };
        }
        if (table === 'Organization') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Firm' }, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildMemberApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'newadmin@example.com', role: 'ADMIN' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Only admins');
    });

    it('returns 400 INVITE_ALREADY_MEMBER when target is already in the org', async () => {
      const currentUser = {
        id: 'internal-admin-1',
        name: 'Admin User',
        email: 'admin@testfirm.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'ADMIN',
      };
      let userSelectCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'User') {
          userSelectCount++;
          if (userSelectCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: currentUser, error: null }),
                }),
              }),
            };
          }
          // 2nd User select: existing member check → returns a row
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: 'existing-member' }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'Organization') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Firm' }, error: null }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'existing@testfirm.com', role: 'MEMBER' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITE_ALREADY_MEMBER');
    });

    it('returns 400 INVITE_ALREADY_PENDING when a pending invitation exists', async () => {
      const currentUser = {
        id: 'internal-admin-1',
        name: 'Admin User',
        email: 'admin@testfirm.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'ADMIN',
      };
      let userSelectCount = 0;
      mockSupabase.from.mockImplementation((table: string) => {
        if (table === 'User') {
          userSelectCount++;
          if (userSelectCount === 1) {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: currentUser, error: null }),
                }),
              }),
            };
          }
          // existing-user check returns null
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'Organization') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({ data: { name: 'Test Firm' }, error: null }),
              }),
            }),
          };
        }
        if (table === 'Invitation') {
          // existing pending invite check returns a row
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: { id: 'inv-pending' }, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      const app = await buildApp();
      const res = await request(app)
        .post('/api/invitations')
        .send({ email: 'pending@example.com', role: 'MEMBER' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVITE_ALREADY_PENDING');
    });
  });

  // ── GET /api/invitations/verify/:token (public) ────────────────
  describe('GET /api/invitations/verify/:token', () => {
    it('returns invitation payload for a valid PENDING token', async () => {
      const invitation = {
        id: 'inv-1',
        email: 'invitee@example.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'MEMBER',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        inviter: { name: 'Admin', avatar: null },
        organization: { id: 'org-A', name: 'Test Firm', logo: null },
      };
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: invitation, error: null }),
          }),
        }),
      });

      const app = await buildPublicApp();
      const res = await request(app).get('/api/invitations/verify/valid_token_123');

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.email).toBe('invitee@example.com');
      expect(res.body.role).toBe('MEMBER');
      expect(res.body.firmName).toBe('Test Firm');
    });

    it('returns 404 for an invalid (unknown) token', async () => {
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: { code: 'PGRST116' } }),
          }),
        }),
      });

      const app = await buildPublicApp();
      const res = await request(app).get('/api/invitations/verify/nope_token');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Invalid invitation');
    });

    it('returns 410 for an expired token', async () => {
      const invitation = {
        id: 'inv-exp',
        email: 'old@example.com',
        firmName: 'Test Firm',
        organizationId: 'org-A',
        role: 'MEMBER',
        status: 'PENDING',
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
        inviter: { name: 'Admin', avatar: null },
        organization: { id: 'org-A', name: 'Test Firm', logo: null },
      };
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            single: async () => ({ data: invitation, error: null }),
          }),
        }),
      });

      const app = await buildPublicApp();
      const res = await request(app).get('/api/invitations/verify/expired_token');

      expect(res.status).toBe(410);
      expect(res.body.error).toContain('expired');
    });
  });

  // ── DELETE /api/invitations/:id ────────────────────────────────
  describe('DELETE /api/invitations/:id', () => {
    it('returns 204 when invitation belongs to caller org', async () => {
      mockSupabase.from.mockReturnValue({
        // select(...).eq('id', id).eq('organizationId', orgId).single() → row
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'inv-1', email: 'x@example.com', organizationId: 'org-A' },
                error: null,
              }),
            }),
          }),
        }),
        // update({status: 'REVOKED'}).eq('id', id).eq('organizationId', orgId) → ok
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).delete('/api/invitations/inv-1');

      expect(res.status).toBe(204);
    });

    it('returns 404 when invitation not found in caller org (cross-org blocked)', async () => {
      // The org check is enforced via the .eq('organizationId', orgId) filter —
      // an invitation belonging to a different org will not match and the
      // select returns no rows. The handler turns that into a 404.
      mockSupabase.from.mockReturnValue({
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        }),
      });

      const app = await buildApp();
      const res = await request(app).delete('/api/invitations/inv-other-org');

      expect(res.status).toBe(404);
    });
  });
});

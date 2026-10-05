/**
 * Invitation accept / join / list / resend flows (USERFLOW-SMOOTHING batch 2).
 *
 * Mounts the real invitations router (which sub-mounts invitations-accept)
 * against a chainable in-memory Supabase mock. Security cases for the
 * authenticated "join with an existing account" endpoint are mandatory:
 * wrong email, expired / already-used token, user already in another org,
 * and the success path (user attached + invitation ACCEPTED + audit log).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  makeSupabaseChainMock,
  filterValue,
  type ChainOp,
  type ChainResult,
} from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
const authAdmin = { createUser: vi.fn(), deleteUser: vi.fn() };
const signUp = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (t: string) => chain.from(t),
    auth: { admin: authAdmin, signUp },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const auditLog = vi.fn();
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: (...a: unknown[]) => auditLog(...a) } }));
vi.mock('../src/routes/notifications.js', () => ({ createNotification: vi.fn() }));
vi.mock('../src/routes/onboarding.js', () => ({ tryCompleteOnboardingStep: vi.fn() }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => {
    if (!req.user?.organizationId) throw new Error('Organization ID not available');
    return req.user.organizationId;
  },
}));
const createInviteeSession = vi.fn();
vi.mock('../src/services/inviteSession.js', () => ({
  createInviteeSession: (...a: unknown[]) => createInviteeSession(...a),
}));
const invalidateUserContext = vi.fn();
vi.mock('../src/middleware/authContextCache.js', () => ({
  invalidateUserContext: (...a: unknown[]) => invalidateUserContext(...a),
  getCachedUserContext: vi.fn(),
  setCachedUserContext: vi.fn(),
}));
// Real authMiddleware verifies a JWT with Supabase; the test stand-in reads
// the caller from a header so each case can choose who is signed in.
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ error: 'Unauthorized' });
    req.user = JSON.parse(String(raw));
    next();
  },
}));
delete process.env.RESEND_API_KEY;

const FUTURE = new Date(Date.now() + 3 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    email: 'Jane@Acme.com',
    firmName: 'Acme Capital',
    organizationId: 'org-A',
    role: 'MEMBER',
    status: 'PENDING',
    token: 'tok-1',
    expiresAt: FUTURE,
    organization: { id: 'org-A', name: 'Acme Capital', logo: null },
    inviter: { name: 'Founder', avatar: null },
    ...overrides,
  };
}

const writes = () => chain.calls.filter((c) => c.action !== 'select');
const writesTo = (table: string, action: string) =>
  chain.calls.filter((c) => c.table === table && c.action === action);

async function publicApp() {
  const { default: router } = await import('../src/routes/invitations-accept.js');
  const app = express();
  app.use(express.json());
  app.use('/api/public/invitations', router);
  return app;
}

async function adminApp() {
  const { default: router } = await import('../src/routes/invitations.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-admin', email: 'admin@acme.com', role: 'ADMIN', organizationId: 'org-A' };
    next();
  });
  app.use('/api/invitations', router);
  return app;
}

const jane = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'auth-jane', email: 'jane@acme.com', emailConfirmed: true, role: 'MEMBER', user_metadata: {}, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  chain.calls.length = 0;
  resolver = () => undefined;
});

// ── Verify ─────────────────────────────────────────────────────────
describe('GET /verify/:token', () => {
  it('reports accountExists when the invited email already has an account', async () => {
    resolver = (op) => {
      if (op.table === 'Invitation') return { data: invitation() };
      if (op.table === 'User') return { data: [{ id: 'u-jane' }] };
      return undefined;
    };
    const res = await request(await publicApp()).get('/api/public/invitations/verify/tok-1');
    expect(res.status).toBe(200);
    expect(res.body.accountExists).toBe(true);
    const userLookup = chain.calls.find((c) => c.table === 'User')!;
    expect(filterValue(userLookup, 'email', 'ilike')).toBe('jane@acme.com');
  });

  it('reports accountExists=false for a brand-new email', async () => {
    resolver = (op) => (op.table === 'Invitation' ? { data: invitation() } : { data: [] });
    const res = await request(await publicApp()).get('/api/public/invitations/verify/tok-1');
    expect(res.body.accountExists).toBe(false);
  });
});

// ── Accept (new account) ───────────────────────────────────────────
describe('POST /accept/:token (new account)', () => {
  const body = { password: 'Str0ng!Passw0rd', fullName: 'Jane Doe' };

  it('creates a confirmed user, attaches them, marks ACCEPTED and returns a session', async () => {
    authAdmin.createUser.mockResolvedValue({ data: { user: { id: 'auth-new' } }, error: null });
    createInviteeSession.mockResolvedValue({ access_token: 'at', refresh_token: 'rt' });
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') return { data: invitation() };
      if (op.table === 'User' && op.action === 'insert') return { data: { id: 'u-new' } };
      if (op.table === 'Invitation' && op.action === 'update') return { data: [{ id: 'inv-1' }] };
      return { data: [] };
    };

    const res = await request(await publicApp()).post('/api/public/invitations/accept/tok-1').send(body);

    expect(res.status).toBe(200);
    expect(res.body.session).toEqual({ access_token: 'at', refresh_token: 'rt' });
    expect(signUp).not.toHaveBeenCalled();
    expect(authAdmin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'Jane@Acme.com', email_confirm: true }),
    );
    const userInsert = writesTo('User', 'insert')[0];
    expect(userInsert.payload).toMatchObject({ authId: 'auth-new', organizationId: 'org-A', role: 'MEMBER' });
    const accepted = writesTo('Invitation', 'update')[0];
    expect(accepted.payload).toMatchObject({ status: 'ACCEPTED' });
  });

  it('rolls back the auth user and leaves the invite PENDING when the User insert fails', async () => {
    authAdmin.createUser.mockResolvedValue({ data: { user: { id: 'auth-new' } }, error: null });
    authAdmin.deleteUser.mockResolvedValue({ error: null });
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') return { data: invitation() };
      if (op.table === 'User' && op.action === 'insert') return { error: { message: 'boom', code: '23505' } };
      return { data: [] };
    };

    const res = await request(await publicApp()).post('/api/public/invitations/accept/tok-1').send(body);

    expect(res.status).toBe(500);
    expect(authAdmin.deleteUser).toHaveBeenCalledWith('auth-new');
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
    expect(createInviteeSession).not.toHaveBeenCalled();
  });

  it('returns 409 ACCOUNT_EXISTS (and writes nothing) when the email already has an account', async () => {
    authAdmin.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered', code: 'email_exists', status: 422 },
    });
    resolver = (op) => (op.table === 'Invitation' && op.action === 'select' ? { data: invitation() } : { data: [] });

    const res = await request(await publicApp()).post('/api/public/invitations/accept/tok-1').send(body);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_EXISTS');
    expect(writes()).toHaveLength(0);
  });

  it('rejects a weak password before touching auth', async () => {
    const res = await request(await publicApp())
      .post('/api/public/invitations/accept/tok-1')
      .send({ password: 'short', fullName: 'Jane' });
    expect(res.status).toBe(400);
    expect(authAdmin.createUser).not.toHaveBeenCalled();
  });
});

// ── Join (existing, signed-in account) ─────────────────────────────
describe('POST /join/:token (existing account, authenticated)', () => {
  interface JoinWorld {
    inv?: Record<string, unknown> | null;
    user?: Record<string, unknown> | null;
    otherMembers?: number;
    deals?: number;
  }
  function joinWorld(w: JoinWorld) {
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') return { data: w.inv === undefined ? invitation() : w.inv };
      if (op.table === 'User' && op.action === 'select') {
        if (op.selectOptions?.head) return { count: w.otherMembers ?? 0 };
        if (filterValue(op, 'authId') === 'auth-jane') return { data: w.user ?? null };
        return { data: [] };
      }
      if (op.table === 'Deal' && op.action === 'select') return { count: w.deals ?? 0 };
      if (op.action === 'update' || op.action === 'insert') return { data: [{ id: 'row' }] };
      return { data: [] };
    };
  }
  const join = async (user: string | null = jane()) => {
    const req = request(await publicApp()).post('/api/public/invitations/join/tok-1');
    return user ? req.set('x-test-user', user) : req;
  };

  it('requires authentication', async () => {
    joinWorld({});
    const res = await join(null);
    expect(res.status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  // Defence in depth: email match proves nothing if the account never
  // confirmed that it owns the address.
  it('403s an account whose email is not confirmed (no writes)', async () => {
    joinWorld({ user: { id: 'u-jane', organizationId: null, role: 'MEMBER' } });
    const res = await join(jane({ emailConfirmed: false }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_CONFIRMED');
    expect(writesTo('User', 'update')).toHaveLength(0);
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
  });

  it('403s when the signed-in email does not match the invitation (no writes)', async () => {
    joinWorld({ user: { id: 'u-mallory', organizationId: null, role: 'MEMBER' } });
    const res = await join(jane({ id: 'auth-jane', email: 'mallory@evil.com' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVITE_EMAIL_MISMATCH');
    expect(writesTo('User', 'update')).toHaveLength(0);
    expect(writesTo('User', 'insert')).toHaveLength(0);
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
  });

  it('matches the email case-insensitively', async () => {
    joinWorld({ user: null });
    const res = await join(jane({ email: 'JANE@acme.COM' }));
    expect(res.status).toBe(200);
  });

  it('410s for an expired token without attaching the user', async () => {
    joinWorld({ inv: invitation({ expiresAt: PAST }), user: null });
    const res = await join();
    expect(res.status).toBe(410);
    expect(writesTo('User', 'insert')).toHaveLength(0);
    expect(writesTo('User', 'update')).toHaveLength(0);
  });

  it('410s for an already-accepted token', async () => {
    joinWorld({ inv: invitation({ status: 'ACCEPTED' }), user: null });
    const res = await join();
    expect(res.status).toBe(410);
    expect(writes()).toHaveLength(0);
  });

  it('404s for an unknown token', async () => {
    joinWorld({ inv: null });
    const res = await join();
    expect(res.status).toBe(404);
  });

  it('refuses (409) to move a user out of an org that has other members or deals', async () => {
    joinWorld({ user: { id: 'u-jane', organizationId: 'org-B', role: 'ADMIN' }, otherMembers: 2, deals: 5 });
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVITE_USER_IN_OTHER_ORG');
    expect(writesTo('User', 'update')).toHaveLength(0);
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
  });

  it('refuses (409) when the other org has deals even if the user is its only member', async () => {
    joinWorld({ user: { id: 'u-jane', organizationId: 'org-B', role: 'MEMBER' }, otherMembers: 0, deals: 1 });
    const res = await join();
    expect(res.status).toBe(409);
    expect(writesTo('User', 'update')).toHaveLength(0);
  });

  it('moves a user out of an empty personal workspace, marks ACCEPTED and audit-logs the join', async () => {
    joinWorld({ user: { id: 'u-jane', organizationId: 'org-solo', role: 'MEMBER' }, otherMembers: 0, deals: 0 });
    const res = await join();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, organizationId: 'org-A' });
    const upd = writesTo('User', 'update')[0];
    expect(upd.payload).toMatchObject({ organizationId: 'org-A', role: 'MEMBER' });
    expect(filterValue(upd, 'id')).toBe('u-jane');
    expect(filterValue(upd, 'organizationId')).toBe('org-solo'); // conditional (TOCTOU) update
    const acc = writesTo('Invitation', 'update')[0];
    expect(acc.payload).toMatchObject({ status: 'ACCEPTED' });
    expect(filterValue(acc, 'status')).toBe('PENDING');
    expect(invalidateUserContext).toHaveBeenCalledWith('auth-jane');
    expect(auditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'INVITATION_ACCEPTED',
        resourceId: 'inv-1',
        metadata: expect.objectContaining({ organizationId: 'org-A', previousOrganizationId: 'org-solo', existingAccount: true }),
      }),
    );
  });

  it('inserts a User row for a signed-in account that has none yet', async () => {
    joinWorld({ user: null });
    const res = await join();
    expect(res.status).toBe(200);
    expect(writesTo('User', 'insert')[0].payload).toMatchObject({
      authId: 'auth-jane',
      organizationId: 'org-A',
      role: 'MEMBER',
    });
  });

  it('is idempotent for someone already in the inviting org', async () => {
    joinWorld({ user: { id: 'u-jane', organizationId: 'org-A', role: 'MEMBER' } });
    const res = await join();
    expect(res.status).toBe(200);
    expect(res.body.alreadyMember).toBe(true);
    expect(writesTo('User', 'update')).toHaveLength(0);
    expect(writesTo('Invitation', 'update')[0].payload).toMatchObject({ status: 'ACCEPTED' });
  });

  it('does not mark the invite ACCEPTED when attaching the user fails', async () => {
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') return { data: invitation() };
      if (op.table === 'User' && op.action === 'select') return { data: null };
      if (op.table === 'User' && op.action === 'insert') return { error: { message: 'boom' } };
      return { data: [] };
    };
    const res = await join();
    expect(res.status).toBe(500);
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
  });
});

// ── List / create / resend / revoke (admin) ────────────────────────
describe('admin invitation management', () => {
  it('derives EXPIRED from expiresAt and ACCEPTED from org membership', async () => {
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') {
        return {
          data: [
            { ...invitation({ id: 'inv-exp', email: 'old@x.com', expiresAt: PAST }), inviter: null },
            { ...invitation({ id: 'inv-joined', email: 'Jane@Acme.com' }), inviter: null },
            { ...invitation({ id: 'inv-open', email: 'new@x.com' }), inviter: null },
          ],
        };
      }
      if (op.table === 'User' && op.action === 'select') return { data: [{ email: 'jane@acme.com' }] };
      return { data: [] };
    };
    const res = await request(await adminApp()).get('/api/invitations');
    const byId = Object.fromEntries(res.body.map((r: any) => [r.id, r]));
    expect(byId['inv-exp'].status).toBe('EXPIRED');
    expect(byId['inv-exp'].inviteUrl).toBeNull();
    expect(byId['inv-joined'].status).toBe('ACCEPTED');
    expect(byId['inv-joined'].inviteUrl).toBeNull();
    expect(byId['inv-open'].status).toBe('PENDING');
    expect(byId['inv-open'].inviteUrl).toContain('/accept-invite?token=');
    // The stale PENDING row for the member is repaired in the DB.
    const repair = writesTo('Invitation', 'update').find((c) => (c.payload as any)?.status === 'ACCEPTED');
    expect(repair).toBeTruthy();
    expect(filterValue(repair!, 'id', 'in')).toEqual(['inv-joined']);
  });

  it('lets an admin re-invite an email whose pending invite has expired', async () => {
    resolver = (op) => {
      if (op.table === 'User' && op.action === 'select') {
        if (filterValue(op, 'authId')) {
          return { data: { id: 'u-admin', name: 'Admin', email: 'admin@acme.com', organizationId: 'org-A', role: 'ADMIN' } };
        }
        return { data: null };
      }
      if (op.table === 'Organization') return { data: { name: 'Acme Capital' } };
      if (op.table === 'Invitation' && op.action === 'select') return { data: { id: 'inv-old', expiresAt: PAST } };
      if (op.table === 'Invitation' && op.action === 'insert') return { data: { id: 'inv-new', email: 'old@x.com' } };
      return { data: [] };
    };
    const res = await request(await adminApp()).post('/api/invitations').send({ email: 'old@x.com', role: 'MEMBER' });
    expect(res.status).toBe(201);
    const expire = writesTo('Invitation', 'update')[0];
    expect(expire.payload).toMatchObject({ status: 'EXPIRED' });
    expect(filterValue(expire, 'id')).toBe('inv-old');
  });

  it('can resend an EXPIRED invitation (status back to PENDING, new expiry)', async () => {
    resolver = (op) => {
      if (op.table === 'Invitation' && op.action === 'select') return { data: invitation({ status: 'EXPIRED', expiresAt: PAST }) };
      if (op.table === 'User') return { data: { name: 'Admin' } };
      if (op.table === 'Organization') return { data: { name: 'Acme Capital' } };
      return { data: [] };
    };
    const res = await request(await adminApp()).post('/api/invitations/inv-1/resend');
    expect(res.status).toBe(200);
    const upd = writesTo('Invitation', 'update')[0];
    expect(upd.payload).toMatchObject({ status: 'PENDING' });
    expect(new Date((upd.payload as any).expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to resend or revoke an ACCEPTED invitation', async () => {
    resolver = (op) =>
      op.table === 'Invitation' && op.action === 'select' ? { data: invitation({ status: 'ACCEPTED' }) } : { data: [] };
    const app = await adminApp();
    expect((await request(app).post('/api/invitations/inv-1/resend')).status).toBe(400);
    expect((await request(app).delete('/api/invitations/inv-1')).status).toBe(400);
    expect(writesTo('Invitation', 'update')).toHaveLength(0);
  });
});

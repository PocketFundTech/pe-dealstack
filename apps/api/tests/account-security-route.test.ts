import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ───── Mocks (MUST be declared before the dynamic import) ─────────

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendPasswordChangedEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/passwordChangedEmail.js', () => ({
  sendPasswordChangedEmail: mockSendPasswordChangedEmail,
}));

const mockSendNewDeviceLoginEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/newDeviceLoginEmail.js', () => ({
  sendNewDeviceLoginEmail: mockSendNewDeviceLoginEmail,
}));

// ───── Test app builder ─────────────────────────────────────────────
// Fake auth — mirrors what the real authMiddleware would attach (see
// welcome-email-route.test.ts / invitations.test.ts for the same pattern).
const buildApp = async (user: Record<string, unknown> | null) => {
  const { default: accountSecurityRouter } = await import('../src/routes/account-security.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/account/security', accountSecurityRouter);
  return app;
};

const testUser = { id: 'user-1', email: 'real@user.com', name: 'Real Name', role: 'MEMBER' };

// Builds a chainable Supabase `from('KnownLoginDevice')` stub covering every
// path the route exercises: select().eq().eq().maybeSingle(), update().eq(),
// and insert().
function makeKnownDeviceFrom(opts: {
  existing?: { id: string } | null;
  lookupError?: unknown;
  updateError?: unknown;
  insertError?: unknown;
}) {
  return vi.fn().mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.existing ?? null,
            error: opts.lookupError ?? null,
          }),
        }),
      }),
    }),
    update: () => ({
      eq: async () => ({ error: opts.updateError ?? null }),
    }),
    insert: async () => ({ error: opts.insertError ?? null }),
  });
}

describe('POST /api/account/security/password-changed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('sends using the server-attached req.user email/name, ignoring any client-supplied body', async () => {
    const app = await buildApp(testUser);
    const res = await request(app)
      .post('/api/account/security/password-changed')
      .send({ to: 'spoofed@evil.com', name: 'Spoofed' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(mockSendPasswordChangedEmail).toHaveBeenCalledWith({
      to: 'real@user.com',
      name: 'Real Name',
    });
  });

  it('responds {sent:false} without calling the email service when req.user has no email', async () => {
    const app = await buildApp({ id: 'user-2', role: 'MEMBER' });
    const res = await request(app).post('/api/account/security/password-changed').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendPasswordChangedEmail).not.toHaveBeenCalled();
  });

  it('propagates a false result from the email service without throwing', async () => {
    mockSendPasswordChangedEmail.mockResolvedValueOnce(false);
    const app = await buildApp(testUser);
    const res = await request(app).post('/api/account/security/password-changed').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
  });
});

describe('POST /api/account/security/login-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('known device: updates lastSeenAt and never sends an email', async () => {
    mockSupabase.from.mockImplementation(
      makeKnownDeviceFrom({ existing: { id: 'device-1' } })
    );

    const app = await buildApp(testUser);
    const res = await request(app)
      .post('/api/account/security/login-check')
      .set('User-Agent', 'vitest-agent')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false, known: true });
    expect(mockSendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });

  it('unknown device: inserts a new row and sends the alert email', async () => {
    mockSupabase.from.mockImplementation(makeKnownDeviceFrom({ existing: null }));

    const app = await buildApp(testUser);
    const res = await request(app)
      .post('/api/account/security/login-check')
      .set('User-Agent', 'vitest-agent')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, known: false });
    expect(mockSendNewDeviceLoginEmail).toHaveBeenCalledWith({
      to: 'real@user.com',
      name: 'Real Name',
    });
  });

  it('responds {sent:false} without touching the DB when req.user is missing', async () => {
    const app = await buildApp(null);
    const res = await request(app).post('/api/account/security/login-check').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('never throws and responds {sent:false} when the lookup query errors', async () => {
    mockSupabase.from.mockImplementation(
      makeKnownDeviceFrom({ lookupError: { message: 'db down' } })
    );

    const app = await buildApp(testUser);
    const res = await request(app).post('/api/account/security/login-check').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });

  it('never throws and responds {sent:false} when the insert fails', async () => {
    mockSupabase.from.mockImplementation(
      makeKnownDeviceFrom({ existing: null, insertError: { message: 'constraint violation' } })
    );

    const app = await buildApp(testUser);
    const res = await request(app).post('/api/account/security/login-check').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendNewDeviceLoginEmail).not.toHaveBeenCalled();
  });
});

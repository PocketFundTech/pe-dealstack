import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetUserById = vi.fn();
const mockSupabase = {
  auth: { admin: { getUserById: mockGetUserById } },
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendWelcomeEmail = vi.fn().mockResolvedValue(true);
vi.mock('../src/services/welcomeEmail.js', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

const buildApp = async () => {
  const { default: welcomeEmailRouter } = await import('../src/routes/welcome-email.js');
  const app = express();
  app.use(express.json());
  app.use('/api/public/welcome-email', welcomeEmailRouter);
  return app;
};

describe('POST /api/public/welcome-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends using the server-looked-up email and name, ignoring any client-supplied ones', async () => {
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'real@user.com',
          created_at: new Date().toISOString(),
          user_metadata: { full_name: 'Real Name' },
        },
      },
      error: null,
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/public/welcome-email')
      .send({ userId: 'user-1', email: 'spoofed@evil.com', name: 'Spoofed' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(mockSendWelcomeEmail).toHaveBeenCalledWith({ to: 'real@user.com', name: 'Real Name' });
  });

  it('no-ops without calling sendWelcomeEmail when the account is older than 15 minutes', async () => {
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          id: 'user-1',
          email: 'real@user.com',
          created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          user_metadata: {},
        },
      },
      error: null,
    });

    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({ userId: 'user-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('no-ops when the user lookup fails', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: 'not found' } });

    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({ userId: 'nope' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('no-ops when userId is missing from the request body', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/public/welcome-email').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: false });
    expect(mockGetUserById).not.toHaveBeenCalled();
  });
});

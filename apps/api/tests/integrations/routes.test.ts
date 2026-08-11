import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

describe('GET /api/integrations', () => {
  it("returns the user's connected integrations (org-scoped)", async () => {
    vi.doMock('../../src/supabase.js', () => ({
      supabase: {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'i-1',
                provider: 'granola',
                status: 'connected',
                externalAccountEmail: 'x@y.com',
                lastSyncAt: null,
                organizationId: 'org-1',
                userId: 'u-1',
              },
            ],
            error: null,
          }),
        })),
      },
    }));
    vi.doMock('../../src/middleware/auth.js', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { id: 'auth-1', organizationId: 'org-1' };
        next();
      },
    }));
    vi.doMock('../../src/middleware/orgScope.js', () => ({
      orgMiddleware: (_req: any, _res: any, next: any) => next(),
      requireOrg: (_req: any, _res: any, next: any) => next(),
      getOrgId: () => 'org-1',
    }));
    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations.js')).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
    app.use('/api/integrations', router);

    const res = await request(app).get('/api/integrations');
    expect(res.status).toBe(200);
    expect(res.body.integrations).toHaveLength(1);
    expect(res.body.integrations[0].provider).toBe('granola');
    expect(res.body.integrations[0].accessTokenEncrypted).toBeUndefined();
  });
});

describe('POST /api/integrations/webhooks/:provider', () => {
  it('returns 404 for an unregistered provider', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));

    const { _resetRegistryForTests } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations-public.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/integrations', router);

    const res = await request(app)
      .post('/api/integrations/webhooks/granola')
      .send({ event: 'test' });
    expect(res.status).toBe(404);
  });

  it('returns 204 when registered provider handles webhook successfully', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();
    const handleWebhook = vi.fn().mockResolvedValue(undefined);
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync: vi.fn(),
      handleWebhook, disconnect: vi.fn(),
    } as any);

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations-public.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/integrations', router);

    const res = await request(app)
      .post('/api/integrations/webhooks/_mock')
      .send({ event: 'test' });
    expect(res.status).toBe(204);
    expect(handleWebhook).toHaveBeenCalled();
  });
});

describe('POST /api/integrations/:provider/api-key', () => {
  it('rejects when provider has no connectWithApiKey implementation', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();
    registerProvider({
      id: 'granola', displayName: 'G', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync: vi.fn(),
      handleWebhook: vi.fn(), disconnect: vi.fn(),
      // intentionally no connectWithApiKey
    } as any);

    vi.doMock('../../src/middleware/auth.js', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { id: 'auth-1', organizationId: 'org-1' }; next();
      },
    }));
    vi.doMock('../../src/middleware/orgScope.js', () => ({
      orgMiddleware: (_req: any, _res: any, next: any) => next(),
      requireOrg: (_req: any, _res: any, next: any) => next(),
      getOrgId: () => 'org-1',
    }));

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations.js')).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
    app.use('/api/integrations', router);

    const res = await request(app)
      .post('/api/integrations/granola/api-key')
      .send({ apiKey: 'grn_test12345' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not accept api keys/i);
  });

  it('returns 400 with the error message when validation fails (e.g. plan-required)', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();
    registerProvider({
      id: 'granola', displayName: 'G', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync: vi.fn(),
      handleWebhook: vi.fn(), disconnect: vi.fn(),
      connectWithApiKey: vi.fn().mockRejectedValue(
        new Error('Plan not supported — Granola API requires Business or Enterprise')
      ),
    } as any);

    vi.doMock('../../src/middleware/auth.js', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { id: 'auth-1', organizationId: 'org-1' }; next();
      },
    }));
    vi.doMock('../../src/middleware/orgScope.js', () => ({
      orgMiddleware: (_req: any, _res: any, next: any) => next(),
      requireOrg: (_req: any, _res: any, next: any) => next(),
      getOrgId: () => 'org-1',
    }));
    // Stub resolveInternalUserId path: routes uses supabase.from('User').select(...)
    // The default {from: vi.fn()} mock returns undefined → resolveInternalUserId returns null →
    // route would return 404. So override the supabase mock for User lookup:
    vi.doMock('../../src/supabase.js', () => ({
      supabase: {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { id: 'u-1' }, error: null }),
        })),
      },
    }));

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations.js')).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
    app.use('/api/integrations', router);

    const res = await request(app)
      .post('/api/integrations/granola/api-key')
      .send({ apiKey: 'grn_test12345' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/plan/i);
  });
});

describe('GET /api/integrations/activities', () => {
  it('returns IntegrationActivity rows filtered by dealId, org-scoped', async () => {
    const order = vi.fn().mockReturnThis();
    const limit = vi.fn().mockReturnThis();
    const contains = vi.fn().mockResolvedValue({
      data: [
        { id: 'a-1', source: 'granola', externalId: 'n-1', type: 'MEETING',
          title: 'Founder call', occurredAt: '2026-04-30T10:00:00Z',
          dealIds: ['d-1'], contactIds: ['c-1'], aiExtraction: null },
      ],
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ order, limit, contains });
    order.mockReturnValue({ limit, contains });
    limit.mockReturnValue({ contains });

    vi.doMock('../../src/supabase.js', () => ({
      supabase: {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnValue({ eq }),
        })),
      },
    }));
    vi.doMock('../../src/middleware/auth.js', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { id: 'auth-1', organizationId: 'org-1' }; next();
      },
    }));
    vi.doMock('../../src/middleware/orgScope.js', () => ({
      orgMiddleware: (_req: any, _res: any, next: any) => next(),
      requireOrg: (_req: any, _res: any, next: any) => next(),
      getOrgId: () => 'org-1',
    }));

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations.js')).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
    app.use('/api/integrations', router);

    const res = await request(app)
      .get('/api/integrations/activities')
      .query({ dealId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(200);
    expect(res.body.activities).toHaveLength(1);
    expect(res.body.activities[0].source).toBe('granola');
  });

  it('rejects with 400 when neither dealId nor contactId is provided', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));
    vi.doMock('../../src/middleware/auth.js', () => ({
      authMiddleware: (req: any, _res: any, next: any) => {
        req.user = { id: 'auth-1', organizationId: 'org-1' }; next();
      },
    }));
    vi.doMock('../../src/middleware/orgScope.js', () => ({
      orgMiddleware: (_req: any, _res: any, next: any) => next(),
      requireOrg: (_req: any, _res: any, next: any) => next(),
      getOrgId: () => 'org-1',
    }));

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations.js')).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { id: 'auth-1', organizationId: 'org-1' }; next(); });
    app.use('/api/integrations', router);

    const res = await request(app).get('/api/integrations/activities');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dealId or contactId/i);
  });
});

/** Settings → Integrations: the Gmail auto-deal toggle (Organization.settings.autoDeal). */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let orgSettings: Record<string, unknown> = {};
let saved: Record<string, unknown> | null = null;
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: { settings: orgSettings }, error: null }),
        update: (row: { settings: Record<string, unknown> }) => { saved = row.settings; return { eq: async () => ({ error: null }) }; },
      };
      return b;
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1' }));
vi.mock('../src/integrations/_platform/syncEngine.js', () => ({ syncIntegration: vi.fn() }));
vi.mock('../src/integrations/_platform/registry.js', () => ({ getProvider: vi.fn(), isProviderRegistered: () => false }));

const { default: router } = await import('../src/routes/integrations.js');

function app(role: string) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: 'u1', role }; next(); });
  a.use('/api/integrations', router);
  return a;
}

beforeEach(() => {
  orgSettings = { firmProfile: { name: 'Avise' }, autoDeal: { internalDomain: 'avise.io' } };
  saved = null;
});

describe('GET /api/integrations/auto-deal', () => {
  it('defaults to off at 85%, and tells non-admins they cannot edit', async () => {
    const res = await request(app('VIEWER')).get('/api/integrations/auto-deal');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, createThreshold: 0.85, canEdit: false });
  });

  it('reports the saved state to an admin', async () => {
    orgSettings = { autoDeal: { enabled: true, createThreshold: 0.95 } };
    const res = await request(app('ADMIN')).get('/api/integrations/auto-deal');
    expect(res.body).toEqual({ enabled: true, createThreshold: 0.95, canEdit: true });
  });
});

describe('PATCH /api/integrations/auto-deal', () => {
  it('turns it on, keeping other org settings and autoDeal keys', async () => {
    const res = await request(app('ADMIN')).patch('/api/integrations/auto-deal').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(saved).toEqual({ firmProfile: { name: 'Avise' }, autoDeal: { internalDomain: 'avise.io', enabled: true } });
  });

  it('is admin-only', async () => {
    const res = await request(app('MEMBER')).patch('/api/integrations/auto-deal').send({ enabled: true });
    expect(res.status).toBe(403);
    expect(saved).toBeNull();
  });

  it('rejects an out-of-range threshold or an empty body', async () => {
    expect((await request(app('ADMIN')).patch('/api/integrations/auto-deal').send({ createThreshold: 0.2 })).status).toBe(400);
    expect((await request(app('ADMIN')).patch('/api/integrations/auto-deal').send({})).status).toBe(400);
    expect(saved).toBeNull();
  });
});

/**
 * Pressing Cancel on Google's consent screen sends the user back with
 * ?error=access_denied and no code. The callback answered with a bare
 * plain-text 400 "Missing code or state", stranding the user outside the app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const handleCallback = vi.fn();
vi.mock('../../src/integrations/_platform/registry.js', () => ({
  isProviderRegistered: () => true,
  getProvider: () => ({ handleCallback }),
}));
vi.mock('../../src/integrations/_platform/webhookRouter.js', () => ({ routeWebhook: vi.fn() }));
vi.mock('../../src/integrations/_platform/syncEngine.js', () => ({ syncAll: vi.fn() }));
vi.mock('../../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

async function buildApp() {
  const express = (await import('express')).default;
  const router = (await import('../../src/routes/integrations-public.js')).default;
  const app = express();
  app.use('/api/integrations', router);
  return app;
}

beforeEach(() => handleCallback.mockReset());

describe('GET /api/integrations/oauth/:provider/callback', () => {
  it('sends a user who cancelled at Google back to Settings with a "cancelled" status', async () => {
    const res = await request(await buildApp()).get('/api/integrations/oauth/google_calendar/callback?error=access_denied&state=s1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/settings?integrations=cancelled&provider=google_calendar#section-integrations');
    expect(handleCallback).not.toHaveBeenCalled();
  });

  it('sends a callback with no code back to Settings as an error, not a raw 400', async () => {
    const res = await request(await buildApp()).get('/api/integrations/oauth/gmail/callback?state=s1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/settings?integrations=error&provider=gmail#section-integrations');
  });

  it('still completes a normal connect', async () => {
    handleCallback.mockResolvedValue(undefined);
    const res = await request(await buildApp()).get('/api/integrations/oauth/gmail/callback?code=c1&state=s1');
    expect(handleCallback).toHaveBeenCalledWith({ code: 'c1', state: 's1' });
    expect(res.headers.location).toBe('/settings?integrations=connected&provider=gmail#section-integrations');
  });

  it('never reflects an arbitrary provider string into the redirect unescaped', async () => {
    const res = await request(await buildApp()).get('/api/integrations/oauth/a%26b%3Dc/callback?error=access_denied');
    expect(res.headers.location).toContain('provider=a%26b%3Dc');
  });
});

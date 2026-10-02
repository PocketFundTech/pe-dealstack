/**
 * QA #6 (1 Oct 2026): Gmail / Google / Granola connect failed with "unexpected
 * error". Missing server config and Granola's own errors must reach the user
 * as a real reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));

const ENV = { ...process.env };
beforeEach(() => { vi.resetModules(); });
afterEach(() => { process.env = { ...ENV }; vi.unstubAllGlobals(); });

describe('Google OAuth config', () => {
  it('missing GOOGLE_CLIENT_ID / SECRET → 503 INTEGRATION_NOT_CONFIGURED with a readable message', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const { googleClientCreds } = await import('../src/integrations/_platform/errors.js');
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const app = express();
    app.get('/x', () => { googleClientCreds(); });
    app.use(errorHandler);
    process.env.NODE_ENV = 'production';
    const res = await request(app).get('/x');
    expect(res.status).toBe(503);
    const body = JSON.stringify(res.body);
    expect(body).toContain("Google sign-in isn't set up on this server yet");
    expect(body).toContain('INTEGRATION_NOT_CONFIGURED');
    expect(body).not.toContain('GOOGLE_CLIENT_ID');        // env names stay in the log
    expect(body).not.toContain('An unexpected error occurred');
  });

  it('APP_URL missing in production refuses a localhost redirect URI', async () => {
    delete process.env.APP_URL;
    process.env.NODE_ENV = 'production';
    const { appBaseUrl } = await import('../src/integrations/_platform/errors.js');
    expect(() => appBaseUrl()).toThrow(/isn't set up/);
  });

  it('APP_URL is used without a trailing slash', async () => {
    process.env.APP_URL = 'https://app.avise.io/';
    const { appBaseUrl } = await import('../src/integrations/_platform/errors.js');
    expect(appBaseUrl()).toBe('https://app.avise.io');
  });
});

describe('Granola key check', () => {
  const stubFetch = (status: number, body = '') =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

  it('an unexpected Granola status is reported with the status and body', async () => {
    stubFetch(404, 'Not Found: /v1/me');
    const { validateKey } = await import('../src/integrations/granola/client.js');
    await expect(validateKey('k')).rejects.toMatchObject({
      statusCode: 502,
      message: "Granola couldn't verify this key (HTTP 404: Not Found: /v1/me).",
    });
  });

  it('401 and 403 keep their specific messages', async () => {
    stubFetch(401);
    let { validateKey } = await import('../src/integrations/granola/client.js');
    await expect(validateKey('k')).rejects.toThrow('Invalid API key');
    vi.resetModules();
    stubFetch(403);
    ({ validateKey } = await import('../src/integrations/granola/client.js'));
    await expect(validateKey('k')).rejects.toThrow(/Business or Enterprise/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

describe('webhook raw body capture', () => {
  it('passes the original raw bytes to provider.handleWebhook', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();

    let capturedRawBody: Buffer | undefined;
    let capturedParsedBody: unknown;
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync: vi.fn(),
      handleWebhook: async (_headers: any, body: any, rawBody?: Buffer) => {
        capturedRawBody = rawBody;
        capturedParsedBody = body;
      },
      disconnect: vi.fn(),
    } as any);

    const express = (await import('express')).default;
    const router = (await import('../../src/routes/integrations-public.js')).default;
    const app = express();
    // Mirror the production verify hook
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as any).rawBody = Buffer.from(buf);
      },
    }));
    app.use('/api/integrations', router);

    // Send a payload where key order in JSON.stringify(parsed) would NOT match the original bytes.
    const rawJson = '{"b":1,"a":2}';
    const res = await request(app)
      .post('/api/integrations/webhooks/_mock')
      .set('Content-Type', 'application/json')
      .send(rawJson);

    expect(res.status).toBe(204);
    expect(capturedParsedBody).toEqual({ b: 1, a: 2 });
    expect(capturedRawBody).toBeInstanceOf(Buffer);
    expect(capturedRawBody?.toString('utf8')).toBe(rawJson);
    // JSON.stringify of parsed body would re-order keys alphabetically OR preserve insertion order;
    // the point is that capturedRawBody is the BYTES the client sent, which is what HMAC needs.
  });
});

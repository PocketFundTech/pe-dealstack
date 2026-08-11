import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('gmail client', () => {
  it('exchangeCode posts authorization_code grant to Google', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'gmail.readonly userinfo.email',
    }), { status: 200 })) as unknown as typeof fetch;

    const { exchangeCode } = await import('../../../src/integrations/gmail/client.js');
    const tokens = await exchangeCode('the-code', 'http://localhost/callback');
    expect(tokens.access_token).toBe('at');
    expect(tokens.refresh_token).toBe('rt');
    const callArgs = (global.fetch as any).mock.calls[0];
    expect(callArgs[0]).toMatch(/oauth2\.googleapis\.com\/token$/);
    expect(callArgs[1].body).toContain('grant_type=authorization_code');
    expect(callArgs[1].body).toContain('code=the-code');
  });

  it('refreshAccessToken posts refresh_token grant', async () => {
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csec';
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-at', expires_in: 3600,
    }), { status: 200 })) as unknown as typeof fetch;

    const { refreshAccessToken } = await import('../../../src/integrations/gmail/client.js');
    const tokens = await refreshAccessToken('rt');
    expect(tokens.access_token).toBe('new-at');
    expect((global.fetch as any).mock.calls[0][1].body).toContain('grant_type=refresh_token');
  });

  it('getUserInfo returns email + name', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'me@firm.com', name: 'Me', verified_email: true,
    }), { status: 200 })) as unknown as typeof fetch;
    const { getUserInfo } = await import('../../../src/integrations/gmail/client.js');
    const info = await getUserInfo('access-token');
    expect(info.email).toBe('me@firm.com');
    expect(info.name).toBe('Me');
    expect((global.fetch as any).mock.calls[0][1].headers.Authorization).toBe('Bearer access-token');
  });

  it('listMessagesSince builds q with after:<unix> and from-OR-to filter for known emails', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({
        messages: [{ id: 'm1', threadId: 't1' }],
        nextPageToken: undefined,
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const { listMessagesSince } = await import('../../../src/integrations/gmail/client.js');
    const messages = await listMessagesSince('at', new Date('2026-04-29T00:00:00Z'), [
      'john@acme.com', 'sara@beta.io',
    ]);
    expect(messages).toHaveLength(1);
    const url = calls[0];
    expect(url).toMatch(/gmail\/v1\/users\/me\/messages/);
    // The q param contains an after: clause and an OR list of from:/to: addresses
    expect(decodeURIComponent(url)).toMatch(/after:\d+/);
    expect(decodeURIComponent(url)).toMatch(/john@acme\.com/);
    expect(decodeURIComponent(url)).toMatch(/sara@beta\.io/);
  });

  it('listMessagesSince returns empty array when known-emails list is empty', async () => {
    global.fetch = vi.fn();
    const { listMessagesSince } = await import('../../../src/integrations/gmail/client.js');
    const messages = await listMessagesSince('at', new Date(), []);
    expect(messages).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('getMessage fetches /messages/{id}?format=metadata-and-snippet', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'm1', threadId: 't1',
      payload: { headers: [{ name: 'Subject', value: 'Hi' }] },
    }), { status: 200 })) as unknown as typeof fetch;
    const { getMessage } = await import('../../../src/integrations/gmail/client.js');
    const msg = await getMessage('at', 'm1');
    expect(msg.id).toBe('m1');
    expect((global.fetch as any).mock.calls[0][0]).toMatch(/messages\/m1\?format=metadata/);
  });
});

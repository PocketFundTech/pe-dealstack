import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  vi.resetModules();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('googleCalendar client', () => {
  it('exchangeCode posts authorization_code grant', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 3600,
    }), { status: 200 })) as unknown as typeof fetch;
    const { exchangeCode } = await import('../../../src/integrations/googleCalendar/client.js');
    const r = await exchangeCode('the-code', 'http://localhost/cb');
    expect(r.access_token).toBe('at');
    expect((global.fetch as any).mock.calls[0][1].body).toContain('grant_type=authorization_code');
  });

  it('refreshAccessToken posts refresh_token grant', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-at', expires_in: 3600,
    }), { status: 200 })) as unknown as typeof fetch;
    const { refreshAccessToken } = await import('../../../src/integrations/googleCalendar/client.js');
    const r = await refreshAccessToken('rt');
    expect(r.access_token).toBe('new-at');
    expect((global.fetch as any).mock.calls[0][1].body).toContain('grant_type=refresh_token');
  });

  it('listEventsBetween paginates and orders by startTime', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          items: [{ id: 'e1', summary: 'A', start: { dateTime: '2026-04-30T10:00:00Z' } }],
          nextPageToken: 'page-2',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        items: [{ id: 'e2', summary: 'B', start: { dateTime: '2026-04-30T11:00:00Z' } }],
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const { listEventsBetween } = await import('../../../src/integrations/googleCalendar/client.js');
    const events = await listEventsBetween('at', new Date('2026-04-29T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    expect(events.map(e => e.id)).toEqual(['e1', 'e2']);
    expect(decodeURIComponent(calls[0])).toMatch(/calendars\/primary\/events/);
    expect(decodeURIComponent(calls[0])).toMatch(/timeMin=2026-04-29T00:00:00\.000Z/);
    expect(decodeURIComponent(calls[0])).toMatch(/singleEvents=true/);
    expect(decodeURIComponent(calls[0])).toMatch(/orderBy=startTime/);
    expect(calls[1]).toContain('pageToken=page-2');
  });

  it('getUserInfo returns email + name', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'me@firm.com', name: 'Me', verified_email: true,
    }), { status: 200 })) as unknown as typeof fetch;
    const { getUserInfo } = await import('../../../src/integrations/googleCalendar/client.js');
    const info = await getUserInfo('at');
    expect(info.email).toBe('me@firm.com');
  });

  it('getUserInfo surfaces the hd (hosted domain) claim', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'me@acme.com', name: 'Me', hd: 'acme.com',
    }), { status: 200 })) as unknown as typeof fetch;
    const { getUserInfo } = await import('../../../src/integrations/googleCalendar/client.js');
    const info = await getUserInfo('at');
    expect(info.hd).toBe('acme.com');
  });

  it('isWorkspaceAccount is true when hd is present (managed Workspace)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'me@acme.com', hd: 'acme.com',
    }), { status: 200 })) as unknown as typeof fetch;
    const { isWorkspaceAccount } = await import('../../../src/integrations/googleCalendar/client.js');
    expect(await isWorkspaceAccount('at')).toBe(true);
  });

  it('isWorkspaceAccount is false for a personal account (no hd)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      email: 'me@gmail.com',
    }), { status: 200 })) as unknown as typeof fetch;
    const { isWorkspaceAccount } = await import('../../../src/integrations/googleCalendar/client.js');
    expect(await isWorkspaceAccount('at')).toBe(false);
  });
});

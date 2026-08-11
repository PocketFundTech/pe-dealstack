import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.DATA_ENCRYPTION_KEY =
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'csec';
  process.env.OAUTH_STATE_SECRET = 'test-state-secret-padding-32-chars';
  process.env.APP_URL = 'http://localhost:3001';
  vi.resetModules();
});

describe('googleCalendarProvider.sync', () => {
  it('lists events, matches attendees, upserts CALENDAR_EVENT rows', async () => {
    vi.doMock('../../../src/integrations/googleCalendar/client.js', () => ({
      CALENDAR_SCOPES: ['calendar.readonly'],
      buildAuthorizeUrl: vi.fn(),
      exchangeCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      getUserInfo: vi.fn(),
      listEventsBetween: vi.fn().mockResolvedValue([
        {
          id: 'e-1', status: 'confirmed', summary: 'Acme call',
          start: { dateTime: '2026-04-30T15:00:00Z' },
          end:   { dateTime: '2026-04-30T15:30:00Z' },
          attendees: [{ email: 'john@acme.com', displayName: 'John' }],
        },
      ]),
    }));
    vi.doMock('../../../src/integrations/_platform/tokenStore.js', () => ({
      encryptForStorage: (v: string) => v,
      decryptFromStorage: (v: string) => v,
      saveTokens: vi.fn(),
    }));

    const upsert = vi.fn().mockResolvedValue({ error: null });
    const fromMock = vi.fn();
    fromMock.mockReturnValueOnce({  // matcher: Contact lookup
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ id: 'c-1', email: 'john@acme.com' }],
        error: null,
      }),
    });
    fromMock.mockReturnValueOnce({  // matcher: ContactDeal lookup
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [{ dealId: 'd-1' }], error: null }),
    });
    fromMock.mockReturnValueOnce({ upsert });
    vi.doMock('../../../src/supabase.js', () => ({
      supabase: { from: fromMock },
    }));

    const { googleCalendarProvider } = await import('../../../src/integrations/googleCalendar/index.js');
    const integration = {
      id: 'i-1', organizationId: 'org-1', userId: 'u-1', provider: 'google_calendar',
      status: 'connected',
      accessTokenEncrypted: 'fake', refreshTokenEncrypted: 'fake-rt',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [], settings: {}, lastSyncAt: null, lastSyncError: null,
      consecutiveFailures: 0, externalAccountId: null, externalAccountEmail: null,
      createdAt: '2026-04-30T00:00:00Z', updatedAt: '2026-04-30T00:00:00Z',
    } as any;

    const result = await googleCalendarProvider.sync(integration, {});
    expect(result.itemsSynced).toBe(1);
    expect(result.itemsMatched).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'i-1',
        source: 'google_calendar',
        externalId: 'e-1',
        type: 'CALENDAR_EVENT',
        dealIds: ['d-1'],
        contactIds: ['c-1'],
        title: 'Acme call',
      }),
      { onConflict: 'integrationId,source,externalId' }
    );
  });
});

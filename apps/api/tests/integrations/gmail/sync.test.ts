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

describe('gmailProvider.sync', () => {
  it('lists known-email messages, maps them, upserts IntegrationActivity', async () => {
    // Stub Gmail HTTP
    vi.doMock('../../../src/integrations/gmail/client.js', () => ({
      GMAIL_SCOPES: ['gmail.readonly'],
      buildAuthorizeUrl: vi.fn(),
      exchangeCode: vi.fn(),
      refreshAccessToken: vi.fn(),
      getUserInfo: vi.fn(),
      listMessagesSince: vi.fn().mockResolvedValue([{ id: 'm-1', threadId: 't-1' }]),
      getMessage: vi.fn().mockResolvedValue({
        id: 'm-1', threadId: 't-1', snippet: 'snip',
        internalDate: String(Date.parse('2026-04-30T10:00:00Z')),
        payload: {
          headers: [
            { name: 'Subject', value: 'Hi' },
            { name: 'From', value: 'john@acme.com' },
            { name: 'To', value: 'me@firm.com' },
          ],
        },
      }),
    }));

    vi.doMock('../../../src/integrations/_platform/tokenStore.js', () => ({
      encryptForStorage: (v: string) => v,
      decryptFromStorage: (v: string) => v,
      saveTokens: vi.fn(),
    }));

    // Mock the org's contacts list (used to build the Gmail q filter),
    // the org settings (auto-deal toggle — defaults OFF in this test) and
    // the matcher.
    const upsert = vi.fn();
    const upsertSelect = vi.fn();
    const upsertSingle = vi
      .fn()
      .mockResolvedValue({ data: { id: 'act-1' }, error: null });
    upsertSelect.mockReturnValue({ single: upsertSingle });
    upsert.mockReturnValue({ select: upsertSelect });
    const fromMock = vi.fn();
    fromMock.mockReturnValueOnce({  // org contacts → emails for q filter
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ email: 'john@acme.com' }, { email: 'sara@beta.io' }],
        error: null,
      }),
    });
    fromMock.mockReturnValueOnce({  // getAutoDealSettings: Organization lookup
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { settings: {} }, error: null }),
    });
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
    fromMock.mockReturnValueOnce({ upsert });  // upsert IntegrationActivity (returns .select().single())
    vi.doMock('../../../src/supabase.js', () => ({
      supabase: { from: fromMock },
    }));

    const { gmailProvider } = await import('../../../src/integrations/gmail/index.js');
    const integration = {
      id: 'i-1', organizationId: 'org-1', userId: 'u-1', provider: 'gmail',
      status: 'connected',
      accessTokenEncrypted: 'fake', refreshTokenEncrypted: 'fake-rt',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [], settings: {}, lastSyncAt: null, lastSyncError: null,
      consecutiveFailures: 0, externalAccountId: null, externalAccountEmail: null,
      createdAt: '2026-04-30T00:00:00Z', updatedAt: '2026-04-30T00:00:00Z',
    } as any;

    const result = await gmailProvider.sync(integration, {});
    expect(result.itemsSynced).toBe(1);
    expect(result.itemsMatched).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'i-1',
        source: 'gmail',
        externalId: 'm-1',
        type: 'EMAIL',
        dealIds: ['d-1'],
        contactIds: ['c-1'],
        title: 'Hi',
      }),
      { onConflict: 'integrationId,source,externalId' }
    );
  });
});

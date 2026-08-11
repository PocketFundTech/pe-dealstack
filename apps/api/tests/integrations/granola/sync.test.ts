import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.DATA_ENCRYPTION_KEY =
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  vi.resetModules();
});

describe('granolaProvider.sync', () => {
  it('lists, matches, fetches transcripts, and upserts IntegrationActivity rows', async () => {
    // Stub Granola HTTP
    vi.doMock('../../../src/integrations/granola/client.js', () => ({
      validateKey: vi.fn(),
      listNotesSince: vi.fn().mockResolvedValue([
        {
          id: 'n1', title: 'Founder call', createdAt: '2026-04-30T10:00:00Z',
          updatedAt: '2026-04-30T10:00:00Z',
          meetingStartedAt: '2026-04-30T10:00:00Z',
          meetingEndedAt:   '2026-04-30T10:30:00Z',
          attendees: [{ email: 'john@acme.com', name: 'John' }],
        },
      ]),
      getNoteWithTranscript: vi.fn().mockResolvedValue({
        id: 'n1', title: 'Founder call', createdAt: '2026-04-30T10:00:00Z',
        updatedAt: '2026-04-30T10:00:00Z',
        meetingStartedAt: '2026-04-30T10:00:00Z',
        meetingEndedAt:   '2026-04-30T10:30:00Z',
        attendees: [{ email: 'john@acme.com', name: 'John' }],
        summary: 'Q1 review',
        transcript: [
          { speakerName: 'John', speakerEmail: 'john@acme.com', text: 'hi', startedAtMs: 0 },
        ],
      }),
    }));

    // Stub the transcript agent so we don't make a real LLM call
    vi.doMock('../../../src/services/agents/meetingTranscriptAgent/index.js', () => ({
      runTranscriptAnalysis: vi.fn().mockResolvedValue({
        summary: 'Test', keyTopics: [], actionItems: [], decisions: [],
        openQuestions: [], mentionedNumbers: [], nextSteps: [], sentiment: 'neutral',
      }),
    }));

    // Stub tokenStore so decryptFromStorage returns the apiKey verbatim
    vi.doMock('../../../src/integrations/_platform/tokenStore.js', () => ({
      encryptForStorage: (v: string) => v,
      decryptFromStorage: (v: string) => v,
    }));

    // Stub supabase: matcher does Contact + ContactDeal lookups, sync does the upsert
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
    fromMock.mockReturnValueOnce({ upsert });  // sync: upsert IntegrationActivity
    vi.doMock('../../../src/supabase.js', () => ({
      supabase: { from: fromMock },
    }));

    const { granolaProvider } = await import('../../../src/integrations/granola/index.js');
    const integration = {
      id: 'i-1', organizationId: 'org-1', userId: 'u-1', provider: 'granola',
      status: 'connected',
      accessTokenEncrypted: 'fake-encrypted',
      refreshTokenEncrypted: null, tokenExpiresAt: null, scopes: [],
      settings: {}, lastSyncAt: null, lastSyncError: null, consecutiveFailures: 0,
      externalAccountId: null, externalAccountEmail: null,
      createdAt: '2026-04-30T00:00:00Z', updatedAt: '2026-04-30T00:00:00Z',
    } as any;

    const result = await granolaProvider.sync(integration, {});
    expect(result.itemsSynced).toBe(1);
    expect(result.itemsMatched).toBe(1);
    expect(result.errors).toEqual([]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'i-1',
        organizationId: 'org-1',
        userId: 'u-1',
        source: 'granola',
        externalId: 'n1',
        type: 'MEETING',
        dealIds: ['d-1'],
        contactIds: ['c-1'],
        title: 'Founder call',
        durationSeconds: 30 * 60,
      }),
      { onConflict: 'integrationId,source,externalId' }
    );
  });

  it('skips notes where no attendee matches a deal or contact', async () => {
    vi.doMock('../../../src/integrations/granola/client.js', () => ({
      validateKey: vi.fn(),
      listNotesSince: vi.fn().mockResolvedValue([
        {
          id: 'n2', title: 'Internal sync', createdAt: '2026-04-30T10:00:00Z',
          updatedAt: '2026-04-30T10:00:00Z',
          meetingStartedAt: null, meetingEndedAt: null,
          attendees: [{ email: 'unknown@nowhere.com', name: 'X' }],
        },
      ]),
      getNoteWithTranscript: vi.fn(),  // should NOT be called
    }));
    vi.doMock('../../../src/services/agents/meetingTranscriptAgent/index.js', () => ({
      runTranscriptAnalysis: vi.fn(),
    }));
    vi.doMock('../../../src/integrations/_platform/tokenStore.js', () => ({
      encryptForStorage: (v: string) => v,
      decryptFromStorage: (v: string) => v,
    }));

    const upsert = vi.fn();
    const fromMock = vi.fn();
    fromMock.mockReturnValueOnce({  // Contact lookup → no matches
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    vi.doMock('../../../src/supabase.js', () => ({
      supabase: { from: fromMock },
    }));

    const { granolaProvider } = await import('../../../src/integrations/granola/index.js');
    const result = await granolaProvider.sync({
      id: 'i-1', organizationId: 'org-1', userId: 'u-1', provider: 'granola',
      status: 'connected',
      accessTokenEncrypted: 'fake', refreshTokenEncrypted: null,
      tokenExpiresAt: null, scopes: [], settings: {}, lastSyncAt: null,
      lastSyncError: null, consecutiveFailures: 0,
      externalAccountId: null, externalAccountEmail: null,
      createdAt: '2026-04-30T00:00:00Z', updatedAt: '2026-04-30T00:00:00Z',
    } as any, {});
    expect(result.itemsSynced).toBe(1);
    expect(result.itemsMatched).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});

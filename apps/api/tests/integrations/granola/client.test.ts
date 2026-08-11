import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  delete process.env.GRANOLA_API_BASE;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('granola client', () => {
  it('validateKey returns user info on 200', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ email: 'a@b.com', name: 'Alice', plan: 'business' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const { validateKey } = await import('../../../src/integrations/granola/client.js');
    const info = await validateKey('grn_test123');
    expect(info.email).toBe('a@b.com');
    expect(info.plan).toBe('business');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/me$/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer grn_test123' }),
      })
    );
  });

  it('validateKey throws "Invalid API key" on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
    const { validateKey } = await import('../../../src/integrations/granola/client.js');
    await expect(validateKey('bad')).rejects.toThrow(/invalid api key/i);
  });

  it('validateKey throws plan-required error on 403', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 403 })) as unknown as typeof fetch;
    const { validateKey } = await import('../../../src/integrations/granola/client.js');
    await expect(validateKey('free-plan-key')).rejects.toThrow(/plan/i);
  });

  it('listNotesSince paginates via cursor', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{
            id: 'n1', title: 'Meeting 1', createdAt: '2026-04-29T10:00:00Z',
            updatedAt: '2026-04-29T11:00:00Z', meetingStartedAt: null,
            meetingEndedAt: null, attendees: [],
          }],
          hasMore: true, nextCursor: 'cur-2',
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 'n2', title: 'Meeting 2', createdAt: '2026-04-30T09:00:00Z',
          updatedAt: '2026-04-30T10:00:00Z', meetingStartedAt: null,
          meetingEndedAt: null, attendees: [],
        }],
        hasMore: false, nextCursor: null,
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const { listNotesSince } = await import('../../../src/integrations/granola/client.js');
    const notes = await listNotesSince('grn_x', '2026-04-29T00:00:00Z');
    expect(notes).toHaveLength(2);
    expect(notes.map(n => n.id)).toEqual(['n1', 'n2']);
    expect(calls[0]).toContain('created_after=2026-04-29T00%3A00%3A00Z');
    expect(calls[1]).toContain('cursor=cur-2');
  });

  it('listNotesSince retries once on 429 with Retry-After: 0', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('', {
          status: 429, headers: { 'Retry-After': '0' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        data: [], hasMore: false, nextCursor: null,
      }), { status: 200 }));
    }) as unknown as typeof fetch;

    const { listNotesSince } = await import('../../../src/integrations/granola/client.js');
    const notes = await listNotesSince('grn_x', '2026-04-29T00:00:00Z');
    expect(notes).toHaveLength(0);
    expect(callCount).toBe(2);
  });

  it('getNoteWithTranscript hits /v1/notes/{id}?include=transcript', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'n1', title: 'X', createdAt: '2026-04-30T09:00:00Z',
      updatedAt: '2026-04-30T10:00:00Z', meetingStartedAt: null,
      meetingEndedAt: null, attendees: [], summary: 'Quick chat',
      transcript: [{ speakerName: 'A', speakerEmail: 'a@b.com', text: 'hi', startedAtMs: 0 }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { getNoteWithTranscript } = await import('../../../src/integrations/granola/client.js');
    const note = await getNoteWithTranscript('grn_x', 'n1');
    expect(note.summary).toBe('Quick chat');
    expect(note.transcript).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/notes\/n1\?include=transcript$/),
      expect.anything()
    );
  });
});

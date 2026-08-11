import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GranolaNoteWithTranscript } from '../../../src/integrations/granola/types.js';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

const fixture: GranolaNoteWithTranscript = {
  id: 'note-1',
  title: 'Acme founder check-in',
  createdAt: '2026-04-30T15:00:00Z',
  updatedAt: '2026-04-30T15:48:00Z',
  meetingStartedAt: '2026-04-30T15:00:00Z',
  meetingEndedAt:   '2026-04-30T15:48:00Z',
  attendees: [
    { email: 'john@acme.com', name: 'John' },
    { email: 'self@firm.com', name: 'Me' },
  ],
  summary: 'Discussed Q1 numbers and plans for EU expansion.',
  transcript: [
    { speakerName: 'John', speakerEmail: 'john@acme.com', text: 'Revenue is up 30%.', startedAtMs: 0 },
    { speakerName: 'Me', speakerEmail: 'self@firm.com', text: 'How is churn?', startedAtMs: 5000 },
  ],
};

describe('granolaNoteToIntegrationActivity', () => {
  it('produces an IntegrationActivity row with AI extraction filled in', async () => {
    const mockInsight = {
      summary: 'Q1 review with positive growth',
      keyTopics: ['Q1 financials'],
      actionItems: [{ who: 'John', what: 'send numbers' }],
      decisions: [],
      openQuestions: ['churn?'],
      mentionedNumbers: [{ value: '30%', context: 'YoY growth' }],
      nextSteps: [],
      sentiment: 'positive' as const,
    };
    const runTranscriptAnalysis = vi.fn().mockResolvedValue(mockInsight);
    vi.doMock('../../../src/services/agents/meetingTranscriptAgent/index.js', () => ({
      runTranscriptAnalysis,
    }));

    const { granolaNoteToIntegrationActivity } = await import(
      '../../../src/integrations/granola/mapper.js'
    );
    const row = await granolaNoteToIntegrationActivity({
      note: fixture,
      integrationId: 'i-1',
      organizationId: 'org-1',
      userId: 'u-1',
      dealIds: ['d-1', 'd-2'],
      contactIds: ['c-1'],
    });

    expect(row.integrationId).toBe('i-1');
    expect(row.organizationId).toBe('org-1');
    expect(row.userId).toBe('u-1');
    expect(row.source).toBe('granola');
    expect(row.externalId).toBe('note-1');
    expect(row.type).toBe('MEETING');
    expect(row.dealIds).toEqual(['d-1', 'd-2']);
    expect(row.contactIds).toEqual(['c-1']);
    expect(row.title).toBe('Acme founder check-in');
    expect(row.summary).toContain('Q1 numbers');
    expect(row.occurredAt).toBe('2026-04-30T15:00:00Z');
    expect(row.durationSeconds).toBe(48 * 60);
    expect(row.metadata).toMatchObject({
      attendees: expect.arrayContaining([
        expect.objectContaining({ email: 'john@acme.com' }),
      ]),
      transcriptSegmentCount: 2,
    });
    expect(row.aiExtraction).toEqual(mockInsight);
    expect(row.rawTranscript).toContain('Revenue is up 30%');
    expect(runTranscriptAnalysis).toHaveBeenCalledWith({
      title: 'Acme founder check-in',
      attendees: fixture.attendees,
      durationSeconds: 48 * 60,
      transcript: expect.stringContaining('John: Revenue is up 30%'),
    });
  });

  it('handles null occurredAt fields by falling back to createdAt and null duration', async () => {
    vi.doMock('../../../src/services/agents/meetingTranscriptAgent/index.js', () => ({
      runTranscriptAnalysis: vi.fn().mockResolvedValue(null),
    }));
    const { granolaNoteToIntegrationActivity } = await import(
      '../../../src/integrations/granola/mapper.js'
    );
    const row = await granolaNoteToIntegrationActivity({
      note: { ...fixture, meetingStartedAt: null, meetingEndedAt: null, summary: null },
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: [], contactIds: [],
    });
    expect(row.occurredAt).toBe('2026-04-30T15:00:00Z'); // createdAt
    expect(row.durationSeconds).toBeNull();
    expect(row.summary).toBe('');
    expect(row.aiExtraction).toBeNull();
  });

  it('still produces a row when the AI extraction throws', async () => {
    vi.doMock('../../../src/services/agents/meetingTranscriptAgent/index.js', () => ({
      runTranscriptAnalysis: vi.fn().mockRejectedValue(new Error('LLM down')),
    }));
    const { granolaNoteToIntegrationActivity } = await import(
      '../../../src/integrations/granola/mapper.js'
    );
    const row = await granolaNoteToIntegrationActivity({
      note: fixture,
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: ['d-1'], contactIds: [],
    });
    expect(row.aiExtraction).toBeNull();
    expect(row.title).toBe('Acme founder check-in');  // row still written
  });
});

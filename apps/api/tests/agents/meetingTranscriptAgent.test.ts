import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

describe('runTranscriptAnalysis', () => {
  it('returns parsed MeetingInsight on a valid LLM response', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: 'Founder reported 30% YoY growth and plans EU expansion in Q3.',
            keyTopics: ['Q1 financials', 'EU expansion plan'],
            actionItems: [{ who: 'John', what: 'Send updated cap table', due: '2026-05-07' }],
            decisions: ['Move forward with reference calls'],
            openQuestions: ['What is current churn?'],
            mentionedNumbers: [
              { value: '$4M ARR', context: 'company revenue current run-rate' },
              { value: '30%', context: 'YoY growth' },
            ],
            nextSteps: ['Schedule follow-up next week'],
            sentiment: 'positive',
          }),
        },
      }],
    });
    vi.doMock('../../src/openai.js', () => ({
      openai: { chat: { completions: { create } } },
    }));

    const { runTranscriptAnalysis } = await import(
      '../../src/services/agents/meetingTranscriptAgent/index.js'
    );
    const result = await runTranscriptAnalysis({
      title: 'Acme Q1 review',
      attendees: [
        { name: 'John', email: 'john@acme.com' },
        { name: 'Me', email: 'self@firm.com' },
      ],
      durationSeconds: 30 * 60,
      transcript: 'John: Revenue is up 30%. Me: Great, what about churn?',
    });
    expect(result).not.toBeNull();
    expect(result!.sentiment).toBe('positive');
    expect(result!.actionItems).toHaveLength(1);
    expect(result!.mentionedNumbers).toHaveLength(2);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('returns null when transcript is empty', async () => {
    vi.doMock('../../src/openai.js', () => ({
      openai: { chat: { completions: { create: vi.fn() } } },
    }));
    const { runTranscriptAnalysis } = await import(
      '../../src/services/agents/meetingTranscriptAgent/index.js'
    );
    const result = await runTranscriptAnalysis({
      title: 'X', attendees: [], durationSeconds: null, transcript: '',
    });
    expect(result).toBeNull();
  });

  it('returns null when openai client is missing', async () => {
    vi.doMock('../../src/openai.js', () => ({ openai: null }));
    const { runTranscriptAnalysis } = await import(
      '../../src/services/agents/meetingTranscriptAgent/index.js'
    );
    const result = await runTranscriptAnalysis({
      title: 'X', attendees: [], durationSeconds: null, transcript: 'hello',
    });
    expect(result).toBeNull();
  });

  it('returns null when LLM output fails schema validation', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ summary: 'ok' }) } }],
    });
    vi.doMock('../../src/openai.js', () => ({
      openai: { chat: { completions: { create } } },
    }));
    const { runTranscriptAnalysis } = await import(
      '../../src/services/agents/meetingTranscriptAgent/index.js'
    );
    const result = await runTranscriptAnalysis({
      title: 'X', attendees: [], durationSeconds: null, transcript: 'hello',
    });
    expect(result).toBeNull();
  });
});

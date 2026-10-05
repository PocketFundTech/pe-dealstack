// Verifies dealEmailClassifier, dealIncrementalUpdate, and
// meetingTranscriptAgent route their raw `openai.chat.completions.create`
// calls through `trackedChatCompletion` (usage-tracked) instead of calling
// the client directly — the untracked-usage gap fixed for these three
// agents. Mocks openai.js's exports directly: `openai` stays truthy (so the
// `if (!openai)` guard in each agent passes) but `openai.chat.completions.create`
// is a spy that throws if called directly, proving the call goes through
// `trackedChatCompletion` instead.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { directCreateSpy, trackedChatCompletion, mockResponsesRef } = vi.hoisted(() => {
  const directCreateSpy = vi.fn(() => {
    throw new Error('openai.chat.completions.create called directly — should go through trackedChatCompletion');
  });
  const mockResponsesRef = { current: {} as Record<string, any> };
  const trackedChatCompletion = vi.fn(async (operation: string) => ({
    choices: [{ message: { content: JSON.stringify(mockResponsesRef.current[operation] ?? {}) } }],
  }));
  return { directCreateSpy, trackedChatCompletion, mockResponsesRef };
});

vi.mock('../src/openai.js', () => ({
  openai: { chat: { completions: { create: directCreateSpy } } },
  trackedChatCompletion: (...args: any[]) => (trackedChatCompletion as any)(...args),
}));

import { runDealEmailClassifier } from '../src/services/agents/dealEmailClassifier/index.js';
import { runDealIncrementalUpdate } from '../src/services/agents/dealIncrementalUpdate/index.js';
import { runTranscriptAnalysis } from '../src/services/agents/meetingTranscriptAgent/index.js';

describe('raw-OpenAI agents now call trackedChatCompletion', () => {
  beforeEach(() => {
    directCreateSpy.mockClear();
    trackedChatCompletion.mockClear();
    mockResponsesRef.current = {};
  });

  it('dealEmailClassifier: uses trackedChatCompletion with an operation label, never the raw client', async () => {
    mockResponsesRef.current.deal_email_classification = {
      isRelevant: true,
      confidence: 0.9,
      dealType: 'cold_pitch',
      reasoning: 'x',
      hints: { companyName: null, sector: null, geography: null, askPrice: null, contactRoles: [] },
    };
    await runDealEmailClassifier({
      subject: 'Selling our company',
      fromName: 'Jane',
      fromEmail: 'jane@example.com',
      toEmails: ['me@firm.com'],
      date: null,
      bodyText: 'We would like to discuss a potential sale.',
    });
    expect(directCreateSpy).not.toHaveBeenCalled();
    expect(trackedChatCompletion).toHaveBeenCalledOnce();
    expect(trackedChatCompletion.mock.calls[0][0]).toBe('deal_email_classification');
  });

  it('dealIncrementalUpdate: uses trackedChatCompletion with an operation label, never the raw client', async () => {
    mockResponsesRef.current.deal_incremental_update = { updates: {}, reasoning: 'x' };
    await runDealIncrementalUpdate({
      deal: { id: 'd1', name: 'Acme' } as any,
      email: { subject: 'Update', from: 'jane@example.com', date: new Date().toISOString(), bodyText: 'progress update' },
    });
    expect(directCreateSpy).not.toHaveBeenCalled();
    expect(trackedChatCompletion).toHaveBeenCalledOnce();
    expect(trackedChatCompletion.mock.calls[0][0]).toBe('deal_incremental_update');
  });

  it('meetingTranscriptAgent: uses trackedChatCompletion with an operation label, never the raw client', async () => {
    mockResponsesRef.current.meeting_transcript_analysis = { summary: 'x', actionItems: [] };
    await runTranscriptAnalysis({
      title: 'Call',
      attendees: [],
      durationSeconds: 600,
      transcript: 'Hello, this is a transcript of the meeting.',
    });
    expect(directCreateSpy).not.toHaveBeenCalled();
    expect(trackedChatCompletion).toHaveBeenCalledOnce();
    expect(trackedChatCompletion.mock.calls[0][0]).toBe('meeting_transcript_analysis');
  });
});

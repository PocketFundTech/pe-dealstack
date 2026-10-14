/**
 * AI cost plan D1: the inbox scan's cheap "is this a deal email?" pre-filter.
 * One batched Haiku call over every candidate email; only the positives go on
 * to the expensive per-email extraction. The scan service is exercised end to
 * end with Gmail, Supabase and the extractor mocked — no live AI calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let nextText = '';
let aiFails = false;
let anthropicAvailable = true;
vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    if (aiFails) throw new Error('credit balance too low');
    return { text: nextText, model: 'claude-haiku-4-5', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
  }),
  isAnthropicAvailable: () => anthropicAvailable,
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

// ─── Scan-service collaborators ──────────────────────────────────
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === 'User' ? { id: 'user-1' } : table === 'Integration' ? { id: 'int-1', tokenExpiresAt: null } : null,
          error: null,
        }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return chain;
    },
  },
}));
vi.mock('../src/integrations/_platform/tokenStore.js', () => ({
  getDecryptedTokens: async () => ({ accessToken: 'tok', refreshToken: 'rtok' }),
  saveTokens: vi.fn(),
  markStatus: vi.fn(async () => {}),
}));

type Msg = { id: string; subject: string; body: string; attachments?: string[] };
let inbox: Msg[] = [];
vi.mock('../src/integrations/gmail/client.js', () => ({
  listRecentDealCandidates: async () => inbox.map((m) => ({ id: m.id, threadId: `t-${m.id}` })),
  getMessageFull: async (_tok: string, id: string) => {
    const m = inbox.find((x) => x.id === id)!;
    return {
      id: m.id, threadId: `t-${m.id}`, snippet: m.body.slice(0, 80), body: m.body,
      attachments: (m.attachments ?? []).map((f) => ({ filename: f, mimeType: 'application/pdf', attachmentId: '', size: 10 })),
      headers: { Subject: m.subject, From: 'banker@example.com', To: '', Cc: '', Date: '2026-10-10', MessageId: '', InReplyTo: '' },
    };
  },
  getAttachment: vi.fn(),
  refreshAccessToken: vi.fn(),
}));
vi.mock('../src/services/pdfExtractor.js', () => ({ extractTextFromPDF: vi.fn(async () => null) }));

const extractedTexts: string[] = [];
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText: vi.fn(async (text: string) => {
    extractedTexts.push(text);
    const company = /Subject: (\S+)/.exec(text)?.[1] ?? 'Unknown';
    const f = (value: any) => ({ value, confidence: 90 });
    return {
      companyName: f(company), industry: f('Software'), description: f('desc'), summary: 's', currency: 'USD',
      revenue: f(10), ebitda: f(2), dealSize: f(30), overallConfidence: 80, reviewReasons: [],
    };
  }),
}));

import {
  classifyDealEmails,
  buildDealEmailFilterSystemPrompt,
  DEAL_EMAIL_FILTER_OPERATION,
  CLASSIFY_BODY_CHARS,
} from '../src/services/inboxDealClassifier.js';
import { scanInboxForDeals, type ScanEvent } from '../src/services/inboxDealScanService.js';

const DEAL_BODY = 'Acquisition opportunity: founder-led SaaS, ARR $4.2M, EBITDA $1.1M, asking 6x.';

beforeEach(() => {
  calls.length = 0;
  extractedTexts.length = 0;
  nextText = '';
  aiFails = false;
  anthropicAvailable = true;
  inbox = [];
});

describe('classifyDealEmails', () => {
  const emails = [
    { id: 'gmail-a', subject: 'Teaser: Acme', from: 'x@bank.com', body: 'A'.repeat(5000), attachmentNames: ['Acme Teaser.pdf'] },
    { id: 'gmail-b', subject: 'Weekly newsletter', from: 'news@x.com', body: 'markets', attachmentNames: [] },
    { id: 'gmail-c', subject: 'Intro: Beta Co', from: 'y@broker.com', body: 'beta', attachmentNames: [] },
  ];

  it('sends ALL emails in one fast-role call with the date injected, and maps keys back to ids', async () => {
    nextText = JSON.stringify({ dealEmailKeys: ['e1', 'e3', 'e99'] });
    const ids = await classifyDealEmails(emails);
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('fast');
    expect(calls[0].operation).toBe(DEAL_EMAIL_FILTER_OPERATION);
    expect(calls[0].system).toContain(new Date().toISOString().slice(0, 10));
    expect(calls[0].outputSchema).toBeTruthy();
    // e99 doesn't exist — ignored, never mapped to a bogus id.
    expect([...ids!].sort()).toEqual(['gmail-a', 'gmail-c']);
  });

  it('truncates each body to the classify budget and includes attachment names', async () => {
    nextText = JSON.stringify({ dealEmailKeys: [] });
    await classifyDealEmails(emails);
    const first = calls[0].messages[0].content[0].text as string;
    expect(first).toContain('Attachments: Acme Teaser.pdf');
    expect(first).toContain('A'.repeat(CLASSIFY_BODY_CHARS));
    expect(first).not.toContain('A'.repeat(CLASSIFY_BODY_CHARS + 1));
  });

  it('fails open (null) on API error, unparseable output, or no credentials', async () => {
    aiFails = true;
    expect(await classifyDealEmails(emails)).toBeNull();
    aiFails = false;
    nextText = 'not json';
    expect(await classifyDealEmails(emails)).toBeNull();
    nextText = JSON.stringify({ somethingElse: [] });
    expect(await classifyDealEmails(emails)).toBeNull();
    anthropicAvailable = false;
    calls.length = 0;
    expect(await classifyDealEmails(emails)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('makes no call for an empty batch', async () => {
    expect(await classifyDealEmails([])).toEqual(new Set());
    expect(calls).toHaveLength(0);
  });

  it('builds the system prompt from the date it is given', () => {
    expect(buildDealEmailFilterSystemPrompt('2031-01-02')).toContain('2031-01-02');
  });
});

describe('scanInboxForDeals with the deal-email pre-filter', () => {
  beforeEach(() => {
    inbox = [
      { id: 'm1', subject: 'Alpha', body: DEAL_BODY },
      { id: 'm2', subject: 'Newsletter', body: `Roundup. ${DEAL_BODY}` },
      { id: 'm3', subject: 'Gamma', body: DEAL_BODY },
      { id: 'm4', subject: 'Delta', body: DEAL_BODY, attachments: ['Delta CIM.pdf'] },
    ];
  });

  it('only extracts emails the classifier marks as deals (deal-doc attachments always kept)', async () => {
    // Classifier keeps Alpha (e1) + Gamma (e3); Delta isn't listed but carries a CIM.
    nextText = JSON.stringify({ dealEmailKeys: ['e1', 'e3'] });
    const events: ScanEvent[] = [];
    const result = await scanInboxForDeals({ orgId: 'org-1', authUserId: 'auth-1', onEvent: (e) => events.push(e) });

    expect(calls).toHaveLength(1); // one batched classifier call, not one per email
    expect(calls[0].messages[0].content).toHaveLength(4 + 1);
    expect(extractedTexts).toHaveLength(3);
    expect(extractedTexts.some((t) => t.includes('Subject: Newsletter'))).toBe(false);
    expect(result.candidates.map((c) => c.companyName).sort()).toEqual(['Alpha', 'Delta', 'Gamma']);
    expect(result.scanned).toBe(4);
    expect(events).toContainEqual({ t: 'skip', subject: 'Newsletter', reason: 'not a deal email (AI pre-check)' });
  });

  it('falls back to extracting every gate-passing email when the classifier fails', async () => {
    aiFails = true;
    const result = await scanInboxForDeals({ orgId: 'org-1', authUserId: 'auth-1' });
    expect(extractedTexts).toHaveLength(4);
    expect(result.candidates).toHaveLength(4);
  });

  it('keeps the result shape unchanged', async () => {
    nextText = JSON.stringify({ dealEmailKeys: ['e1'] });
    const result = await scanInboxForDeals({ orgId: 'org-1', authUserId: 'auth-1' });
    expect(Object.keys(result).sort()).toEqual(['attachmentsUnread', 'candidates', 'connected', 'process', 'scanned']);
    expect(Object.keys(result.process!).sort()).toEqual(['high', 'low', 'medium', 'scanned', 'skippedLowSignal']);
  });
});

/**
 * Smoke tests for the Gmail auto-deal scaffolding.
 *
 * Covers the pure, dep-free pieces:
 *   - preFilter.shouldSkipForAI
 *   - mapper.extractBodyText (base64url-decoded MIME walk)
 *   - mapper.getHeaderMap
 *   - dealEmailClassifier schema validation
 *   - dealIncrementalUpdate schema + SENSITIVE_FIELDS membership
 *
 * Functions that depend on supabase / openai / Gmail HTTP are exercised
 * in higher-level integration tests (not added in this round).
 */

import { describe, it, expect } from 'vitest';

import { shouldSkipForAI } from '../src/integrations/gmail/preFilter.js';
import {
  extractBodyText,
  getHeaderMap,
  parseEmailAddress,
} from '../src/integrations/gmail/mapper.js';
import { dealEmailClassifierSchema } from '../src/services/agents/dealEmailClassifier/schema.js';
import {
  incrementalUpdateSchema,
  SENSITIVE_FIELDS,
} from '../src/services/agents/dealIncrementalUpdate/schema.js';
import type { GmailMessage } from '../src/integrations/gmail/types.js';

// ─── preFilter ────────────────────────────────────────────────────────────

describe('preFilter.shouldSkipForAI', () => {
  const baseHeaders: Record<string, string> = {};
  const base = {
    subject: 'Acme Industries — Sell-side opportunity, $40M revenue',
    snippet: 'We are pleased to share a teaser for Acme Industries...',
    fromEmail: 'banker@keystone.com',
    labels: ['INBOX'],
    headers: baseHeaders,
    orgInternalDomain: 'pocket-fund.com',
  };

  it('passes a banker-style pitch through', () => {
    expect(shouldSkipForAI(base).skip).toBe(false);
  });

  it('skips LinkedIn senders', () => {
    const r = shouldSkipForAI({ ...base, fromEmail: 'jobs-noreply@linkedin.com' });
    expect(r.skip).toBe(true);
  });

  it('skips no-reply / mailer senders', () => {
    const r = shouldSkipForAI({ ...base, fromEmail: 'no-reply@acme.com' });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('noreply-sender');
  });

  it('skips RFC 3834 auto-submitted', () => {
    const r = shouldSkipForAI({
      ...base,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('auto-submitted-header');
  });

  it('skips out-of-office subjects', () => {
    const r = shouldSkipForAI({ ...base, subject: 'Out of Office Re: meeting' });
    expect(r.skip).toBe(true);
  });

  it('skips bulk-list headers', () => {
    const r = shouldSkipForAI({
      ...base,
      headers: { 'List-Unsubscribe': '<mailto:unsub@x.com>' },
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('bulk-list-headers');
  });

  it('skips Gmail promo category', () => {
    const r = shouldSkipForAI({ ...base, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
    expect(r.skip).toBe(true);
  });

  it('skips org-internal sender', () => {
    const r = shouldSkipForAI({ ...base, fromEmail: 'colleague@pocket-fund.com' });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('org-internal');
  });

  it('skips empty body+subject', () => {
    const r = shouldSkipForAI({ ...base, subject: '', snippet: '' });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('too-short');
  });

  it('skips missing from-address', () => {
    const r = shouldSkipForAI({ ...base, fromEmail: '' });
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('no-from-address');
  });
});

// ─── mapper.extractBodyText ───────────────────────────────────────────────

function encodeBody(text: string): string {
  return Buffer.from(text, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('mapper.extractBodyText', () => {
  it('extracts plain text from a simple message', () => {
    const msg: GmailMessage = {
      id: '1',
      threadId: 't1',
      payload: {
        mimeType: 'text/plain',
        body: { data: encodeBody('Hello, this is a deal pitch.') },
      },
    };
    expect(extractBodyText(msg)).toBe('Hello, this is a deal pitch.');
  });

  it('prefers text/plain over text/html in multipart', () => {
    const msg: GmailMessage = {
      id: '2',
      threadId: 't2',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: encodeBody('Plain version') } },
          { mimeType: 'text/html', body: { data: encodeBody('<p>HTML version</p>') } },
        ],
      },
    };
    expect(extractBodyText(msg)).toBe('Plain version');
  });

  it('falls back to stripped HTML when no plain text part exists', () => {
    const msg: GmailMessage = {
      id: '3',
      threadId: 't3',
      payload: {
        mimeType: 'text/html',
        body: { data: encodeBody('<p>Hello <b>world</b></p><br>Line 2') },
      },
    };
    const out = extractBodyText(msg);
    expect(out).toContain('Hello world');
    expect(out).toContain('Line 2');
    expect(out).not.toContain('<p>');
  });

  it('skips attachment parts', () => {
    const msg: GmailMessage = {
      id: '4',
      threadId: 't4',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: encodeBody('Body text') } },
          {
            mimeType: 'application/pdf',
            filename: 'pitch.pdf',
            body: { data: encodeBody('PDF-BINARY-DATA') },
          },
        ],
      },
    };
    expect(extractBodyText(msg)).toBe('Body text');
  });

  it('falls back to snippet if no parts contain data', () => {
    const msg: GmailMessage = {
      id: '5',
      threadId: 't5',
      snippet: 'A snippet preview',
      payload: { mimeType: 'multipart/mixed', parts: [] },
    };
    expect(extractBodyText(msg)).toBe('A snippet preview');
  });
});

describe('mapper.getHeaderMap', () => {
  it('flattens header array into a lookup object', () => {
    const msg: GmailMessage = {
      id: '1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello' },
          { name: 'From', value: 'a@b.com' },
        ],
      },
    };
    const h = getHeaderMap(msg);
    expect(h.Subject).toBe('Hello');
    expect(h.From).toBe('a@b.com');
  });

  it('returns empty object when payload missing', () => {
    expect(getHeaderMap({ id: '1', threadId: 't' } as GmailMessage)).toEqual({});
  });
});

describe('mapper.parseEmailAddress', () => {
  it('parses Name <email> form', () => {
    expect(parseEmailAddress('John Smith <john@acme.com>')).toEqual({
      name: 'John Smith',
      email: 'john@acme.com',
    });
  });

  it('parses bare email form', () => {
    expect(parseEmailAddress('john@acme.com')).toEqual({
      name: null,
      email: 'john@acme.com',
    });
  });

  it('returns null for invalid input', () => {
    expect(parseEmailAddress('not an email')).toBeNull();
  });
});

// ─── dealEmailClassifier schema ───────────────────────────────────────────

describe('dealEmailClassifierSchema', () => {
  it('accepts a well-formed classifier output', () => {
    const ok = {
      isRelevant: true,
      confidence: 0.92,
      dealType: 'banker_intro',
      reasoning: 'Banker pitching a sell-side opportunity.',
      hints: {
        companyName: 'Acme Industries',
        sector: 'Industrials',
        geography: 'US Midwest',
        askPrice: '$40M',
        contactRoles: ['banker'],
      },
    };
    expect(dealEmailClassifierSchema.parse(ok).confidence).toBe(0.92);
  });

  it('rejects confidence outside 0..1', () => {
    const bad = {
      isRelevant: true,
      confidence: 1.5,
      dealType: 'banker_intro',
      reasoning: 'x',
      hints: { companyName: null, sector: null, geography: null, askPrice: null, contactRoles: [] },
    };
    expect(dealEmailClassifierSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown dealType', () => {
    const bad = {
      isRelevant: true,
      confidence: 0.9,
      dealType: 'invented',
      reasoning: 'x',
      hints: { companyName: null, sector: null, geography: null, askPrice: null, contactRoles: [] },
    };
    expect(dealEmailClassifierSchema.safeParse(bad).success).toBe(false);
  });
});

// ─── dealIncrementalUpdate schema ─────────────────────────────────────────

describe('incrementalUpdateSchema', () => {
  it('accepts a no-op update (everything null/empty)', () => {
    const ok = {
      dealSize: null,
      revenue: null,
      ebitda: null,
      stage: null,
      description: null,
      industry: null,
      thesisAppend: null,
      keyRisksAdd: [],
      investmentHighlightsAdd: [],
      contactsToAdd: [],
      reasoning: 'Nothing material in this email.',
    };
    expect(incrementalUpdateSchema.parse(ok).reasoning).toMatch(/nothing/i);
  });

  it('accepts a sensitive-field proposal', () => {
    const ok = {
      dealSize: { value: 8, confidence: 0.95, sourceQuote: 'we are asking $8M' },
      revenue: null,
      ebitda: null,
      stage: null,
      description: null,
      industry: null,
      thesisAppend: null,
      keyRisksAdd: [],
      investmentHighlightsAdd: [],
      contactsToAdd: [],
      reasoning: 'Banker stated new ask price.',
    };
    expect(incrementalUpdateSchema.parse(ok).dealSize?.value).toBe(8);
  });

  it('rejects negative revenue', () => {
    const bad = {
      dealSize: null,
      revenue: { value: -1, confidence: 0.9, sourceQuote: 'x' },
      ebitda: null,
      stage: null,
      description: null,
      industry: null,
      thesisAppend: null,
      keyRisksAdd: [],
      investmentHighlightsAdd: [],
      contactsToAdd: [],
      reasoning: 'x',
    };
    expect(incrementalUpdateSchema.safeParse(bad).success).toBe(false);
  });

  it('exposes SENSITIVE_FIELDS for the auto-update gate', () => {
    expect(SENSITIVE_FIELDS.has('dealSize')).toBe(true);
    expect(SENSITIVE_FIELDS.has('revenue')).toBe(true);
    expect(SENSITIVE_FIELDS.has('ebitda')).toBe(true);
    expect(SENSITIVE_FIELDS.has('stage')).toBe(true);
    expect(SENSITIVE_FIELDS.has('description')).toBe(false);
    expect(SENSITIVE_FIELDS.has('industry')).toBe(false);
  });
});

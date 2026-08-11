import { describe, it, expect } from 'vitest';
import { gmailMessageToIntegrationActivity, parseEmailAddress } from '../../../src/integrations/gmail/mapper.js';
import type { GmailMessage } from '../../../src/integrations/gmail/types.js';

const fixture: GmailMessage = {
  id: 'm-1',
  threadId: 't-1',
  snippet: 'Just confirming numbers from Q1.',
  internalDate: String(Date.parse('2026-04-30T15:00:00Z')),
  payload: {
    headers: [
      { name: 'Subject', value: 'Re: Term sheet feedback' },
      { name: 'From', value: 'John <john@acme.com>' },
      { name: 'To', value: 'me@firm.com' },
      { name: 'Cc', value: '"Sara" <sara@beta.io>, internal@firm.com' },
      { name: 'Date', value: 'Wed, 30 Apr 2026 15:00:00 +0000' },
      { name: 'Message-ID', value: '<abc123@gmail.com>' },
      { name: 'In-Reply-To', value: '<prev@gmail.com>' },
    ],
  },
};

describe('parseEmailAddress', () => {
  it('extracts the email out of "Name <email>" format', () => {
    expect(parseEmailAddress('John <john@acme.com>')).toEqual({ name: 'John', email: 'john@acme.com' });
    expect(parseEmailAddress('jane@y.com')).toEqual({ name: null, email: 'jane@y.com' });
    expect(parseEmailAddress('"Sara" <sara@beta.io>')).toEqual({ name: 'Sara', email: 'sara@beta.io' });
  });
});

describe('gmailMessageToIntegrationActivity', () => {
  it('builds an EMAIL row with parsed headers + addresses + threading metadata', () => {
    const row = gmailMessageToIntegrationActivity({
      message: fixture,
      integrationId: 'i-1',
      organizationId: 'org-1',
      userId: 'u-1',
      dealIds: ['d-1'],
      contactIds: ['c-1'],
    });
    expect(row.source).toBe('gmail');
    expect(row.externalId).toBe('m-1');
    expect(row.type).toBe('EMAIL');
    expect(row.title).toBe('Re: Term sheet feedback');
    expect(row.summary).toContain('Q1');
    expect(row.dealIds).toEqual(['d-1']);
    expect(row.contactIds).toEqual(['c-1']);
    expect(row.occurredAt).toBe(new Date(Number(fixture.internalDate)).toISOString());
    expect(row.metadata).toMatchObject({
      threadId: 't-1',
      messageId: '<abc123@gmail.com>',
      inReplyTo: '<prev@gmail.com>',
      from: { email: 'john@acme.com', name: 'John' },
      to: expect.arrayContaining([expect.objectContaining({ email: 'me@firm.com' })]),
      cc: expect.arrayContaining([
        expect.objectContaining({ email: 'sara@beta.io', name: 'Sara' }),
        expect.objectContaining({ email: 'internal@firm.com' }),
      ]),
    });
    expect(row.aiExtraction).toBeNull();
    expect(row.rawTranscript).toBe('');  // emails don't carry transcripts
  });

  it('falls back to header Date when internalDate is missing', () => {
    const row = gmailMessageToIntegrationActivity({
      message: { ...fixture, internalDate: undefined },
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: [], contactIds: [],
    });
    expect(row.occurredAt).toBe(new Date('Wed, 30 Apr 2026 15:00:00 +0000').toISOString());
  });

  it('handles missing Subject as "(no subject)"', () => {
    const noSubject = {
      ...fixture,
      payload: { headers: fixture.payload!.headers!.filter(h => h.name !== 'Subject') },
    };
    const row = gmailMessageToIntegrationActivity({
      message: noSubject,
      integrationId: 'i-1', organizationId: 'org-1', userId: 'u-1',
      dealIds: [], contactIds: [],
    });
    expect(row.title).toBe('(no subject)');
  });
});

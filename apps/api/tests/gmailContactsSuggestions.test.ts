import { describe, it, expect } from 'vitest';
import { buildContactSuggestions } from '../src/services/gmailContactsService.js';
import type { GmailMessage } from '../src/integrations/gmail/types.js';

// Build a minimal metadata-format GmailMessage with the given headers.
function msg(headers: Record<string, string>): GmailMessage {
  return {
    id: 'm',
    threadId: 't',
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    },
  } as GmailMessage;
}

const OWN = 'me@myfirm.com';

describe('buildContactSuggestions', () => {
  it('tallies frequency + recency and ranks correctly', () => {
    const messages = [
      msg({ From: 'Jane Banker <jane@lazard.com>', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      msg({ From: OWN, To: 'jane@lazard.com', Date: 'Tue, 02 Jun 2026 10:00:00 +0000' }),
      msg({ From: 'Bob <bob@apollo.com>', To: OWN, Date: 'Wed, 03 Jun 2026 10:00:00 +0000' }),
    ];
    const out = buildContactSuggestions(messages, OWN, new Set());
    // jane appears twice, bob once → jane first.
    expect(out.map((s) => s.email)).toEqual(['jane@lazard.com', 'bob@apollo.com']);
    expect(out[0].emailCount).toBe(2);
    expect(out[0].name).toBe('Jane Banker');
    // lastEmailDate is the most-recent message with jane (Jun 02).
    expect(out[0].lastEmailDate.startsWith('2026-06-02')).toBe(true);
  });

  it('excludes the user, automated senders, and existing CRM contacts', () => {
    const messages = [
      msg({ From: OWN, To: 'new@target.com', Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      msg({ From: 'no-reply@bank.com', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      msg({ From: 'notifications@tool.com', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      msg({ From: 'already@known.com', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
    ];
    const out = buildContactSuggestions(messages, OWN, new Set(['already@known.com']));
    const emails = out.map((s) => s.email);
    expect(emails).toContain('new@target.com');
    expect(emails).not.toContain(OWN);
    expect(emails).not.toContain('no-reply@bank.com');
    expect(emails).not.toContain('notifications@tool.com');
    expect(emails).not.toContain('already@known.com');
  });

  it('infers company from a corporate domain but not free-mail', () => {
    const out = buildContactSuggestions(
      [
        msg({ From: 'a@goldmansachs.com', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
        msg({ From: 'b@gmail.com', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      ],
      OWN,
      new Set(),
    );
    const gs = out.find((s) => s.email === 'a@goldmansachs.com');
    const gm = out.find((s) => s.email === 'b@gmail.com');
    expect(gs?.company).toBe('Goldmansachs');
    expect(gm?.company).toBeNull();
  });

  it('respects the cap', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      msg({ From: `p${i}@firm${i}.com`, To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
    );
    expect(buildContactSuggestions(messages, OWN, new Set(), 3)).toHaveLength(3);
  });

  it('is case-insensitive on the owner address and dedupes a contact across messages', () => {
    const messages = [
      msg({ From: 'Jane <JANE@lazard.com>', To: OWN, Date: 'Mon, 01 Jun 2026 10:00:00 +0000' }),
      msg({ From: 'jane@lazard.com', To: 'ME@myfirm.com', Date: 'Tue, 02 Jun 2026 10:00:00 +0000' }),
    ];
    const out = buildContactSuggestions(messages, OWN, new Set());
    // Single deduped entry (address lower-cased), and the owner (upper-cased in header) excluded.
    expect(out).toHaveLength(1);
    expect(out[0].email).toBe('jane@lazard.com');
    expect(out[0].emailCount).toBe(2);
  });
});

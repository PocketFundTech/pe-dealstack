// Smoke test: when userId is missing, the live-integration tools must
// short-circuit with a user-facing message BEFORE touching the DB or Google APIs.
// The full happy path requires mocking the Gmail/Calendar HTTP layer + Supabase
// query builder, which is brittle — keep this lean.

import { describe, it, expect } from 'vitest';
import { makeGetRecentEmailsForDealTool } from '../../src/services/agents/dealChatAgent/tools/getRecentEmailsForDeal.js';
import { makeGetUpcomingMeetingsForDealTool } from '../../src/services/agents/dealChatAgent/tools/getUpcomingMeetingsForDeal.js';

describe('/follow-ups live-integration tools — userId guard', () => {
  it('get_recent_emails_for_deal returns the no-context message when userId is undefined', async () => {
    const t = makeGetRecentEmailsForDealTool('deal-1', 'org-1', undefined);
    const out = await t.invoke({ lookback_days: 14, limit: 10 });
    expect(typeof out).toBe('string');
    expect(out).toContain('User context not available');
  });

  it('get_upcoming_meetings_for_deal returns the no-context message when userId is undefined', async () => {
    const t = makeGetUpcomingMeetingsForDealTool('deal-1', 'org-1', undefined);
    const out = await t.invoke({ past_days: 7, future_days: 14, limit: 10 });
    expect(typeof out).toBe('string');
    expect(out).toContain('User context not available');
  });
});

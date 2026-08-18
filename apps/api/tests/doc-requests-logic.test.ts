/**
 * Pure logic behind document requests: fulfilment status, public-link
 * access checks, and reminder eligibility (spec §3.4, §3.7, §3.9).
 *
 * Kept free of Supabase so the rules that decide "is this link still
 * usable" and "should we email this broker again" are testable in
 * isolation — they're the parts that cause user-visible harm when wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  computeRequestStatus,
  checkRequestAccess,
  isReminderDue,
  REMINDER_MAX_COUNT,
} from '../src/services/docRequests.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function item(required: boolean, fulfilled: boolean) {
  return { required, fulfilledAt: fulfilled ? daysAgo(1) : null };
}

describe('computeRequestStatus', () => {
  it('is OPEN when nothing has been uploaded', () => {
    expect(computeRequestStatus([item(true, false), item(false, false)])).toBe('OPEN');
  });

  it('is PARTIAL when some but not all required items are in', () => {
    expect(computeRequestStatus([item(true, true), item(true, false)])).toBe('PARTIAL');
  });

  it('is FULFILLED once every required item is in, even with optional items outstanding', () => {
    // The required set is what gates completion — otherwise a broker who
    // sent everything that matters still shows as chasing.
    expect(computeRequestStatus([item(true, true), item(false, false)])).toBe('FULFILLED');
  });

  it('is FULFILLED when all items are in', () => {
    expect(computeRequestStatus([item(true, true), item(false, true)])).toBe('FULFILLED');
  });

  it('treats an all-optional request as PARTIAL until at least one arrives', () => {
    expect(computeRequestStatus([item(false, false), item(false, false)])).toBe('OPEN');
    expect(computeRequestStatus([item(false, true), item(false, false)])).toBe('PARTIAL');
  });

  it('is OPEN for an empty checklist rather than falsely complete', () => {
    expect(computeRequestStatus([])).toBe('OPEN');
  });
});

describe('checkRequestAccess', () => {
  const live = { status: 'OPEN', revokedAt: null, expiresAt: null };

  it('allows a live request', () => {
    expect(checkRequestAccess(live, NOW)).toEqual({ ok: true });
  });

  it('404s an unknown token without hinting that it ever existed', () => {
    expect(checkRequestAccess(null, NOW)).toEqual({
      ok: false,
      status: 404,
      error: 'This link is not valid.',
    });
  });

  it('410s a revoked request', () => {
    const res = checkRequestAccess({ ...live, revokedAt: daysAgo(1) }, NOW);
    expect(res).toMatchObject({ ok: false, status: 410 });
  });

  it('410s an expired request', () => {
    const res = checkRequestAccess({ ...live, expiresAt: daysAgo(1) }, NOW);
    expect(res).toMatchObject({ ok: false, status: 410 });
  });

  it('allows a request whose expiry is still in the future', () => {
    expect(checkRequestAccess({ ...live, expiresAt: daysAhead(1) }, NOW)).toEqual({ ok: true });
  });

  it('410s a cancelled request', () => {
    const res = checkRequestAccess({ ...live, status: 'CANCELLED' }, NOW);
    expect(res).toMatchObject({ ok: false, status: 410 });
  });

  it('still allows upload against a fulfilled request', () => {
    // The broker may have more to send than we asked for; a complete
    // checklist should not slam the door on them.
    expect(checkRequestAccess({ ...live, status: 'FULFILLED' }, NOW)).toEqual({ ok: true });
  });
});

describe('isReminderDue', () => {
  const base = {
    status: 'OPEN',
    revokedAt: null,
    expiresAt: null,
    createdAt: daysAgo(10),
    lastRemindedAt: null,
    reminderCount: 0,
    recipientEmail: 'broker@example.com',
  };

  it('is due for an old, never-reminded, still-open request', () => {
    expect(isReminderDue(base, NOW)).toBe(true);
  });

  it('holds off until the request has had a few days to breathe', () => {
    expect(isReminderDue({ ...base, createdAt: daysAgo(1) }, NOW)).toBe(false);
  });

  it('waits out the gap between reminders', () => {
    expect(isReminderDue({ ...base, lastRemindedAt: daysAgo(1), reminderCount: 1 }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, lastRemindedAt: daysAgo(6), reminderCount: 1 }, NOW)).toBe(true);
  });

  it('stops nagging after the cap', () => {
    expect(
      isReminderDue({ ...base, lastRemindedAt: daysAgo(30), reminderCount: REMINDER_MAX_COUNT }, NOW),
    ).toBe(false);
  });

  it('never reminds on a fulfilled, revoked, expired or cancelled request', () => {
    expect(isReminderDue({ ...base, status: 'FULFILLED' }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, status: 'CANCELLED' }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, revokedAt: daysAgo(1) }, NOW)).toBe(false);
    expect(isReminderDue({ ...base, expiresAt: daysAgo(1) }, NOW)).toBe(false);
  });

  it('never reminds when there is no address to remind', () => {
    expect(isReminderDue({ ...base, recipientEmail: null }, NOW)).toBe(false);
  });

  it('reminds on a partially-filled request', () => {
    expect(isReminderDue({ ...base, status: 'PARTIAL' }, NOW)).toBe(true);
  });
});

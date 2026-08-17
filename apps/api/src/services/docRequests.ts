// ─── Document request — pure rules ────────────────────────────────
// Fulfilment status, public-link access checks, and reminder pacing.
// Deliberately Supabase-free: these decide whether an external party can
// still use a link and whether we email a broker again, so they're the
// parts worth testing in isolation. DB access lives in the routes.

export type DocRequestStatus = 'OPEN' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';

/** Days a request must exist before the first nudge goes out. */
export const REMINDER_MIN_AGE_DAYS = 3;
/** Days between nudges. */
export const REMINDER_GAP_DAYS = 5;
/** Hard cap on automatic nudges per request — we chase, we don't harass. */
export const REMINDER_MAX_COUNT = 3;

const DAY_MS = 86_400_000;

interface StatusItem {
  required: boolean;
  fulfilledAt: string | null;
}

/**
 * Fulfilment status of a checklist.
 *
 * FULFILLED is gated on the REQUIRED items only — a broker who sent
 * everything that matters shouldn't still read as outstanding just
 * because an optional nice-to-have never arrived. Outstanding optional
 * items stay visible per-item in the UI.
 */
export function computeRequestStatus(items: StatusItem[]): DocRequestStatus {
  if (items.length === 0) return 'OPEN';

  const anyFulfilled = items.some((i) => i.fulfilledAt);
  if (!anyFulfilled) return 'OPEN';

  const required = items.filter((i) => i.required);
  const allRequiredIn = required.length > 0 && required.every((i) => i.fulfilledAt);
  if (allRequiredIn) return 'FULFILLED';

  // No required items at all: only "everything in" counts as complete.
  if (required.length === 0 && items.every((i) => i.fulfilledAt)) return 'FULFILLED';

  return 'PARTIAL';
}

interface AccessRow {
  status: string;
  revokedAt: string | null;
  expiresAt: string | null;
}

export type AccessResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Whether a token holder may still use this request.
 *
 * Mirrors routes/portal.ts semantics exactly: 404 for an unknown token
 * (never confirm that a token once existed), 410 for one that has been
 * switched off. A FULFILLED request stays open — the counterparty often
 * has more to send than we thought to ask for.
 */
export function checkRequestAccess(row: AccessRow | null, now: Date = new Date()): AccessResult {
  if (!row) return { ok: false, status: 404, error: 'This link is not valid.' };
  if (row.revokedAt) return { ok: false, status: 410, error: 'This link has been revoked.' };
  if (row.status === 'CANCELLED') {
    return { ok: false, status: 410, error: 'This link has been revoked.' };
  }
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now.getTime()) {
    return { ok: false, status: 410, error: 'This link has expired.' };
  }
  return { ok: true };
}

interface ReminderRow extends AccessRow {
  createdAt: string;
  lastRemindedAt: string | null;
  reminderCount: number;
  recipientEmail: string | null;
}

/** Whether the nightly sweep should nudge this request. */
export function isReminderDue(row: ReminderRow, now: Date = new Date()): boolean {
  if (!row.recipientEmail) return false;
  if (row.status !== 'OPEN' && row.status !== 'PARTIAL') return false;
  if (!checkRequestAccess(row, now).ok) return false;
  if (row.reminderCount >= REMINDER_MAX_COUNT) return false;

  const ageDays = (now.getTime() - new Date(row.createdAt).getTime()) / DAY_MS;
  if (ageDays < REMINDER_MIN_AGE_DAYS) return false;

  if (row.lastRemindedAt) {
    const sinceDays = (now.getTime() - new Date(row.lastRemindedAt).getTime()) / DAY_MS;
    if (sinceDays < REMINDER_GAP_DAYS) return false;
  }

  return true;
}

import { api, ApiError } from "@/lib/api";
import type { TeamInvite } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Codes that mean "this teammate is already covered" — not a failure.
const ALREADY_COVERED = new Set(["INVITE_ALREADY_MEMBER", "INVITE_ALREADY_PENDING"]);

export interface TeamInviteResult {
  sent: number;
  /** Invitations created but the email didn't go out (share the link instead). */
  emailNotSent: number;
  alreadyCovered: string[];
  failed: { row: TeamInvite; message: string }[];
}

/**
 * POST each filled row to /invitations (same endpoint as Settings → Team).
 * Blank rows are ignored; invalid emails fail locally without a request.
 */
export async function sendTeamInvites(rows: TeamInvite[]): Promise<TeamInviteResult> {
  const result: TeamInviteResult = { sent: 0, emailNotSent: 0, alreadyCovered: [], failed: [] };

  for (const row of rows) {
    const email = row.email.trim();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      result.failed.push({ row, message: `${email} isn't a valid email address` });
      continue;
    }
    try {
      const res = await api.post<{ emailSent?: boolean }>("/invitations", { email, role: row.role });
      result.sent++;
      if (res?.emailSent === false) result.emailNotSent++;
    } catch (err) {
      if (err instanceof ApiError && err.code && ALREADY_COVERED.has(err.code)) {
        result.alreadyCovered.push(email);
        continue;
      }
      const reason = err instanceof Error ? err.message : "Couldn't send invitation";
      result.failed.push({ row, message: `${email}: ${reason}` });
    }
  }

  return result;
}

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { createNotification } from '../routes/notifications.js';

// Shared pieces of the two ways to accept an invitation:
//   POST /accept/:token — new account (public; the token proves the email)
//   POST /join/:token   — existing account (authenticated; email must match)

export interface InvitationRow {
  id: string;
  email: string;
  firmName: string;
  organizationId: string;
  role: string;
  status: string;
  expiresAt: string;
  organization?: { id: string; name: string } | null;
}

export type InvitationCheck =
  | { ok: true; invitation: InvitationRow }
  | { ok: false; status: number; body: { error: string; code: string } };

/**
 * Load an invitation by token and make sure it can still be accepted
 * (exists, unexpired, PENDING). Expired rows are flipped to EXPIRED so the
 * team list and the duplicate-invite check stay accurate.
 */
export async function loadAcceptableInvitation(token: string): Promise<InvitationCheck> {
  const { data: invitation, error } = await supabase
    .from('Invitation')
    .select('*, organization:Organization!organizationId(id, name)')
    .eq('token', token)
    .single();

  if (error || !invitation) {
    return { ok: false, status: 404, body: { error: 'Invalid invitation', code: 'INVITE_INVALID' } };
  }

  if (invitation.status !== 'PENDING') {
    return {
      ok: false,
      status: 410,
      body: {
        error: `Invitation has already been ${String(invitation.status).toLowerCase()}`,
        code: 'INVITE_NOT_PENDING',
      },
    };
  }

  if (new Date(invitation.expiresAt) < new Date()) {
    await supabase
      .from('Invitation')
      .update({ status: 'EXPIRED' })
      .eq('id', invitation.id)
      .eq('status', 'PENDING');
    return { ok: false, status: 410, body: { error: 'Invitation has expired', code: 'INVITE_EXPIRED' } };
  }

  return { ok: true, invitation: invitation as InvitationRow };
}

/**
 * Flip PENDING → ACCEPTED. Conditional on status so two racing accepts can't
 * both "win"; failures are logged, not thrown — by the time this runs the user
 * is already attached, and GET /invitations reconciles a stale PENDING row
 * whose email is an org member.
 */
export async function markInvitationAccepted(invitationId: string): Promise<void> {
  const { error } = await supabase
    .from('Invitation')
    .update({ status: 'ACCEPTED', acceptedAt: new Date().toISOString() })
    .eq('id', invitationId)
    .eq('status', 'PENDING');
  if (error) log.error('Invite accept: failed to mark invitation ACCEPTED', { invitationId, error });
}

/** Tell the org's admins someone joined. Fire-and-forget. */
export function notifyAdminsOfJoin(organizationId: string, memberName: string, role: string): void {
  void (async () => {
    try {
      const { data: admins } = await supabase
        .from('User')
        .select('id')
        .eq('organizationId', organizationId)
        .eq('role', 'ADMIN');
      for (const admin of admins ?? []) {
        await createNotification({
          userId: admin.id,
          type: 'SYSTEM',
          title: `${memberName} joined your workspace`,
          message: `Accepted invitation as ${role}`,
        });
      }
    } catch (err) {
      log.error('Notification error (invite accept)', err);
    }
  })();
}

/** Escape LIKE wildcards so an email can be matched with ilike exactly. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Same rule the web forms enforce (accept-invite, signup, reset-password). */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain uppercase, lowercase, number, and special character';
  }
  return null;
}

import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { invalidateUserContext } from '../middleware/authContextCache.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import {
  loadAcceptableInvitation,
  markInvitationAccepted,
  applyInvitationDeal,
  notifyAdminsOfJoin,
} from '../services/invitationAccept.js';

// POST /join/:token — accept an invitation with an EXISTING account.
//
// Served at /api/public/invitations/join/:token (the web app calls this one)
// and, via the authenticated invitations router, /api/invitations/join/:token.
// authMiddleware runs inline because the public mount has no auth; orgMiddleware
// is deliberately NOT required — the caller may have no org, or a different one.
//
// Security rules:
//   1. Caller must be signed in (valid Supabase JWT).
//   2. Token must exist, be PENDING and unexpired.
//   3. Caller's email must equal the invitation email (case-insensitive) —
//      possession of the link alone is not enough to join as someone else.
//   4. A user who already belongs to ANOTHER org is never silently moved. The
//      only exception is an empty personal workspace (no other members, no
//      deals) — the one every signup gets auto-created — where moving loses
//      nothing. Otherwise 409 INVITE_USER_IN_OTHER_ORG.
//   5. The invitation is marked ACCEPTED only after the user is attached; the
//      join is audit-logged against the joined org.
const router = Router();

/** Is this org a throwaway personal workspace we can move the user out of? */
async function isEmptyPersonalWorkspace(orgId: string, userId: string): Promise<boolean> {
  const [members, deals] = await Promise.all([
    supabase
      .from('User')
      .select('id', { count: 'exact', head: true })
      .eq('organizationId', orgId)
      .neq('id', userId),
    supabase
      .from('Deal')
      .select('id', { count: 'exact', head: true })
      .eq('organizationId', orgId),
  ]);
  if (members.error || deals.error) {
    log.error('Invite join: workspace emptiness check failed', { orgId, members: members.error, deals: deals.error });
    return false; // fail closed — never move on uncertainty
  }
  return (members.count ?? 1) === 0 && (deals.count ?? 1) === 0;
}

router.post('/join/:token', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authUser = req.user;
    if (!authUser?.id) return res.status(401).json({ error: 'Not authenticated' });

    const check = await loadAcceptableInvitation(req.params.token);
    if (!check.ok) return res.status(check.status).json(check.body);
    const invitation = check.invitation;

    // The email match below only proves anything if the account has
    // confirmed it owns that address.
    if (authUser.emailConfirmed !== true) {
      return res.status(403).json({
        error: 'Confirm your email address first, then accept the invitation.',
        code: 'EMAIL_NOT_CONFIRMED',
      });
    }

    const callerEmail = (authUser.email || '').trim().toLowerCase();
    if (!callerEmail || callerEmail !== invitation.email.trim().toLowerCase()) {
      log.warn('Invite join: email mismatch', { invitationId: invitation.id, authId: authUser.id });
      return res.status(403).json({
        error: `This invitation was sent to ${invitation.email}. Sign in with that email to accept it.`,
        code: 'INVITE_EMAIL_MISMATCH',
      });
    }

    const { data: existing, error: lookupError } = await supabase
      .from('User')
      .select('id, organizationId, role, name')
      .eq('authId', authUser.id)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const targetOrg = invitation.organizationId;
    const previousOrganizationId: string | null = existing?.organizationId ?? null;
    let userId: string | null = existing?.id ?? null;
    let alreadyMember = false;

    if (existing && previousOrganizationId === targetOrg) {
      alreadyMember = true;
    } else if (existing && previousOrganizationId) {
      if (!(await isEmptyPersonalWorkspace(previousOrganizationId, existing.id))) {
        return res.status(409).json({
          error:
            'Your account already belongs to another workspace. Ask that workspace\'s admin to remove you, ' +
            'or contact support to move your account.',
          code: 'INVITE_USER_IN_OTHER_ORG',
        });
      }
      // Conditional on the old org so a concurrent change can't be clobbered.
      const { data: moved, error: moveError } = await supabase
        .from('User')
        .update({ organizationId: targetOrg, role: invitation.role })
        .eq('id', existing.id)
        .eq('organizationId', previousOrganizationId)
        .select('id');
      if (moveError || !moved || (Array.isArray(moved) && moved.length === 0)) {
        log.error('Invite join: moving user into org failed', { moveError, userId: existing.id });
        return res.status(500).json({ error: "We couldn't add you to the workspace. Please try again.", code: 'INVITE_ACCEPT_FAILED' });
      }
    } else if (existing) {
      const { data: attached, error: attachError } = await supabase
        .from('User')
        .update({ organizationId: targetOrg, role: invitation.role })
        .eq('id', existing.id)
        .is('organizationId', null)
        .select('id');
      if (attachError || !attached || (Array.isArray(attached) && attached.length === 0)) {
        log.error('Invite join: attaching user to org failed', { attachError, userId: existing.id });
        return res.status(500).json({ error: "We couldn't add you to the workspace. Please try again.", code: 'INVITE_ACCEPT_FAILED' });
      }
    } else {
      const { data: created, error: insertError } = await supabase
        .from('User')
        .insert({
          authId: authUser.id,
          email: invitation.email,
          name: authUser.name || invitation.email.split('@')[0],
          firmName: invitation.organization?.name || invitation.firmName,
          organizationId: targetOrg,
          role: invitation.role,
          isActive: true,
        })
        .select('id')
        .single();
      if (insertError || !created) {
        log.error('Invite join: User row insert failed', insertError);
        return res.status(500).json({ error: "We couldn't add you to the workspace. Please try again.", code: 'INVITE_ACCEPT_FAILED' });
      }
      userId = created.id;
    }

    await markInvitationAccepted(invitation.id);
    if (userId) await applyInvitationDeal(invitation, userId);
    // Drop the warm-lambda org cache so the next request sees the new org.
    invalidateUserContext(authUser.id);

    // Log against the org the user just joined (AuditLog reads req.user).
    authUser.organizationId = targetOrg;
    authUser.role = invitation.role;
    await AuditLog.log(req, {
      action: 'INVITATION_ACCEPTED',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      userId: userId ?? undefined,
      metadata: {
        email: invitation.email,
        organizationId: targetOrg,
        previousOrganizationId,
        existingAccount: true,
        alreadyMember,
      },
    });

    if (!alreadyMember) {
      notifyAdminsOfJoin(targetOrg, authUser.name || invitation.email.split('@')[0], invitation.role);
    }

    res.json({ success: true, organizationId: targetOrg, alreadyMember });
  } catch (error) {
    next(error);
  }
});

export default router;

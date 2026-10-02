import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { sendInvitationEmail, getExpirationDate } from '../services/invitationEmail.js';
import { createInviteeSession } from '../services/inviteSession.js';
import {
  loadAcceptableInvitation,
  markInvitationAccepted,
  applyInvitationDeal,
  notifyAdminsOfJoin,
  escapeLike,
  passwordProblem,
} from '../services/invitationAccept.js';
import invitationsJoinRouter from './invitations-join.js';

const router = Router();

// POST /join/:token — accept with an EXISTING (signed-in) account.
router.use('/', invitationsJoinRouter);

// Does this email already have an Avise account? Drives "Sign in to accept"
// on the accept-invite page. Only answers for the holder of a valid token for
// that exact email. Best-effort: false on lookup failure (the accept route
// still returns 409 ACCOUNT_EXISTS if it turns out the account exists).
async function emailHasAccount(email: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('User')
      .select('id')
      .ilike('email', escapeLike(email.trim().toLowerCase()))
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    log.warn('Invite verify: account lookup failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function isEmailExistsError(err: { message?: string; code?: string; status?: number } | null): boolean {
  if (!err) return false;
  if (err.code === 'email_exists' || err.code === 'user_already_exists') return true;
  return /already (been )?registered|already exists/i.test(err.message ?? '');
}

// GET /api/invitations/verify/:token - Verify invitation token (public endpoint)
router.get('/verify/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    const { data: invitation, error } = await supabase
      .from('Invitation')
      .select(`
        id,
        email,
        firmName,
        organizationId,
        role,
        status,
        expiresAt,
        inviter:User!invitedBy(name, avatar),
        organization:Organization!organizationId(id, name, logo)
      `)
      .eq('token', token)
      .single();

    if (error || !invitation) {
      return res.status(404).json({ error: 'Invalid invitation' });
    }

    // Check if expired
    if (new Date(invitation.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Invitation has expired' });
    }

    // Check status
    if (invitation.status !== 'PENDING') {
      return res.status(410).json({ error: `Invitation has been ${invitation.status.toLowerCase()}` });
    }

    const org = invitation.organization as any;
    res.json({
      valid: true,
      email: invitation.email,
      firmName: org?.name || invitation.firmName,
      organizationLogo: org?.logo || null,
      role: invitation.role,
      inviter: invitation.inviter,
      accountExists: await emailHasAccount(invitation.email),
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/invitations/accept/:token - Accept invitation with a NEW account.
//
// The emailed token proves the invitee controls the address, so the auth user
// is created already-confirmed (admin.createUser, email_confirm: true) and a
// session is returned for the client to apply — no confirmation email, no
// bounce to /login. Ordering matters: the invitation is only marked ACCEPTED
// after the User row exists; if that insert fails the auth user is deleted so
// the same link can be retried.
router.post('/accept/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;
    const { password, fullName } = req.body ?? {};

    const pwProblem = passwordProblem(password);
    if (pwProblem) {
      return res.status(400).json({ error: pwProblem });
    }

    const check = await loadAcceptableInvitation(token);
    if (!check.ok) return res.status(check.status).json(check.body);
    const invitation = check.invitation;

    const orgName = invitation.organization?.name || invitation.firmName;
    const name = (typeof fullName === 'string' && fullName.trim()) || invitation.email.split('@')[0];

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: invitation.email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: name,
        firm_name: orgName,
        role: invitation.role,
        invited: true,
      },
    });

    if (authError || !authData?.user) {
      if (isEmailExistsError(authError)) {
        return res.status(409).json({
          error: 'An account with this email already exists. Sign in to accept the invitation.',
          code: 'ACCOUNT_EXISTS',
        });
      }
      log.error('Invite accept: auth user creation failed', authError);
      return res.status(400).json({ error: authError?.message || 'Could not create account' });
    }
    const authUserId = authData.user.id;

    const { data: newUser, error: userError } = await supabase
      .from('User')
      .insert({
        authId: authUserId,
        email: invitation.email,
        name,
        firmName: orgName,
        organizationId: invitation.organizationId,
        role: invitation.role,
        isActive: true,
      })
      .select()
      .single();

    if (userError || !newUser) {
      log.error('Invite accept: User row insert failed — rolling back auth user', userError);
      const { error: deleteError } = await supabase.auth.admin.deleteUser(authUserId);
      if (deleteError) log.error('Invite accept: auth user rollback failed', { authUserId, deleteError });
      return res.status(500).json({
        error: "We couldn't finish setting up your account. Please try the invitation link again.",
        code: 'INVITE_ACCEPT_FAILED',
      });
    }

    await markInvitationAccepted(invitation.id);
    await applyInvitationDeal(invitation, newUser.id);

    await AuditLog.log(req, {
      action: 'INVITATION_ACCEPTED',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      userId: newUser.id,
      metadata: { email: invitation.email, organizationId: invitation.organizationId },
    });

    notifyAdminsOfJoin(invitation.organizationId, name, invitation.role);

    const session = await createInviteeSession(invitation.email, password);

    res.json({
      success: true,
      message: 'Account created successfully',
      user: newUser,
      session,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/invitations/:id - Revoke invitation
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Get the invitation — verify it belongs to user's org
    const { data: invitation, error: getError } = await supabase
      .from('Invitation')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (getError || !invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    if (invitation.status === 'ACCEPTED') {
      return res.status(400).json({ error: 'This invitation was already accepted — remove the member instead.' });
    }

    // Update status to revoked
    const { error: updateError } = await supabase
      .from('Invitation')
      .update({ status: 'REVOKED' })
      .eq('id', id)
      .eq('organizationId', orgId);

    if (updateError) throw updateError;

    // Audit log
    await AuditLog.log(req, {
      action: 'INVITATION_REVOKED',
      resourceType: 'Invitation',
      resourceId: id,
      metadata: { email: invitation.email },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/invitations/:id/resend - Resend invitation email
router.post('/:id/resend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const orgId = getOrgId(req);

    if (!user?.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Get invitation — verify it belongs to user's org
    const { data: invitation, error: getError } = await supabase
      .from('Invitation')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (getError || !invitation) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    // PENDING (incl. past expiresAt) and EXPIRED invites can be resent: the
    // resend re-opens the link with a fresh 7-day expiry.
    if (invitation.status !== 'PENDING' && invitation.status !== 'EXPIRED') {
      return res.status(400).json({ error: 'Can only resend pending or expired invitations' });
    }

    const { data: currentUser } = await supabase
      .from('User')
      .select('name')
      .eq('authId', user.id)
      .maybeSingle();

    // Get org name for email
    const { data: org } = await supabase
      .from('Organization')
      .select('name')
      .eq('id', orgId)
      .single();

    const orgName = org?.name || invitation.firmName;

    // Extend expiration (and re-open an EXPIRED invite)
    const newExpiry = getExpirationDate();
    const { error: updateError } = await supabase
      .from('Invitation')
      .update({ status: 'PENDING', expiresAt: newExpiry.toISOString() })
      .eq('id', id)
      .eq('organizationId', orgId);
    if (updateError) {
      // 23505: a newer pending invite exists for this email (unique pending index).
      if ((updateError as { code?: string }).code === '23505') {
        return res.status(409).json({ error: `${invitation.email} already has a newer pending invitation.` });
      }
      throw updateError;
    }

    // Resend email
    const emailResult = await sendInvitationEmail(
      invitation.email,
      currentUser?.name || 'A team member',
      orgName,
      invitation.token,
      invitation.role,
      req
    );

    res.json({
      success: true,
      emailSent: emailResult.success,
      newExpiresAt: newExpiry.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

export default router;

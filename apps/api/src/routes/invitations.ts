import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { supabase } from '../supabase.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

import { sendInvitationEmail, getExpirationDate, resolveBaseUrl } from '../services/invitationEmail.js';

// Sub-routers
import invitationsAcceptRouter from './invitations-accept.js';

const router = Router();

// Validation schemas
const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

// `invites` (QA #4) carries an optional deal per row; `emails` stays for
// older clients. One of the two is required.
const bulkInviteSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(20).optional(),
  invites: z.array(z.object({
    email: z.string().email(),
    dealId: z.string().uuid().nullable().optional(),
  })).min(1).max(20).optional(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
}).refine((v) => v.emails || v.invites, { message: 'emails or invites is required' });

// Helper: Generate secure token
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Mount sub-routers
router.use('/', invitationsAcceptRouter);

// Lower-cased emails of everyone in the org. Best-effort: an empty set just
// means no PENDING → ACCEPTED reconciliation on this request.
async function loadMemberEmails(orgId: string): Promise<Set<string>> {
  try {
    const { data } = await supabase.from('User').select('email').eq('organizationId', orgId);
    return new Set(
      (Array.isArray(data) ? data : [])
        .map((u: { email?: string | null }) => (u.email || '').toLowerCase())
        .filter(Boolean),
    );
  } catch (err) {
    log.warn('Invitation list: member lookup failed', { error: err instanceof Error ? err.message : String(err) });
    return new Set();
  }
}

/**
 * Is there a live (PENDING and unexpired) invitation for this email? A PENDING
 * row past its expiry is flipped to EXPIRED here — it must not block a
 * re-invite, and the unique "one pending invite per email" index would
 * otherwise reject the new row.
 */
async function hasLivePendingInvite(email: string, orgId: string): Promise<boolean> {
  const { data: existing } = await supabase
    .from('Invitation')
    .select('id, expiresAt')
    .eq('email', email)
    .eq('organizationId', orgId)
    .eq('status', 'PENDING')
    .maybeSingle();
  if (!existing) return false;
  if (existing.expiresAt && new Date(existing.expiresAt).getTime() < Date.now()) {
    const { error } = await supabase
      .from('Invitation')
      .update({ status: 'EXPIRED' })
      .eq('id', existing.id)
      .eq('status', 'PENDING');
    if (error) {
      log.warn('Invitation: could not expire stale pending invite', { id: existing.id, error });
      return true;
    }
    return false;
  }
  return true;
}

// GET /api/invitations - List invitations for current user's organization
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { status } = req.query;

    // Build query — filter by organizationId
    let query = supabase
      .from('Invitation')
      .select(`
        id,
        email,
        role,
        status,
        firmName,
        organizationId,
        token,
        createdAt,
        expiresAt,
        acceptedAt,
        inviter:User!invitedBy(id, name, email, avatar)
      `)
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data: invitations, error } = await query;

    if (error) throw error;

    const rows = (invitations || []) as any[];

    // Effective status. Expiry is only written lazily (on an accept attempt),
    // so a PENDING row past expiresAt is shown as EXPIRED. A PENDING row whose
    // email is already a member of the org (joined through another path, or
    // the ACCEPTED write was lost) is shown — and repaired — as ACCEPTED; QA
    // saw accepted teammates stuck on PENDING.
    const memberEmails = await loadMemberEmails(orgId);
    const now = Date.now();
    const repairIds: string[] = [];
    const effective = rows.map((inv) => {
      if (inv.status !== 'PENDING') return inv;
      if (memberEmails.has(String(inv.email).toLowerCase())) {
        repairIds.push(inv.id);
        return { ...inv, status: 'ACCEPTED' };
      }
      if (inv.expiresAt && new Date(inv.expiresAt).getTime() < now) {
        return { ...inv, status: 'EXPIRED' };
      }
      return inv;
    });
    if (repairIds.length > 0) {
      const { error: repairError } = await supabase
        .from('Invitation')
        .update({ status: 'ACCEPTED' })
        .in('id', repairIds)
        .eq('organizationId', orgId)
        .eq('status', 'PENDING');
      if (repairError) log.warn('Invitation list: stale PENDING repair failed', { repairError });
    }

    // Decorate with full invite URL for pending invites; strip token from accepted/expired
    const baseUrl = resolveBaseUrl(req);
    const decorated = effective.map((inv: any) => {
      const isPending = inv.status === 'PENDING';
      const url = isPending && inv.token ? `${baseUrl}/accept-invite?token=${inv.token}` : null;
      // Don't leak the raw token for non-pending invites
      const { token, ...rest } = inv;
      return { ...rest, inviteUrl: url };
    });

    res.json(decorated);
  } catch (error) {
    next(error);
  }
});

// POST /api/invitations - Create and send invitation
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    const orgId = getOrgId(req);
    const validation = createInvitationSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    if (!user?.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { email, role } = validation.data;

    log.info('Creating invitation', { email, role, userId: user.id });

    // Self-invite check — compare against the authenticated user's email
    if (user.email && email.toLowerCase() === user.email.toLowerCase()) {
      return res.status(400).json({
        error: "You can't invite yourself.",
        code: 'INVITE_SELF',
      });
    }

    // Get current user's info + org name
    const { data: currentUser, error: userError } = await supabase
      .from('User')
      .select('id, name, email, firmName, organizationId, role')
      .eq('authId', user.id)
      .maybeSingle();

    if (userError) throw userError;

    if (!currentUser) {
      return res.status(400).json({ error: 'User profile not found' });
    }

    if (!currentUser?.organizationId) {
      return res.status(400).json({ error: 'You must belong to an organization to invite members' });
    }

    // Secondary self-invite check against the User row's email
    if (currentUser.email && email.toLowerCase() === currentUser.email.toLowerCase()) {
      return res.status(400).json({
        error: "You can't invite yourself.",
        code: 'INVITE_SELF',
      });
    }

    // Get org name for email
    const { data: org } = await supabase
      .from('Organization')
      .select('name')
      .eq('id', orgId)
      .single();

    const orgName = org?.name || currentUser.firmName || 'your organization';

    // Only ADMIN can invite ADMINs
    if (role === 'ADMIN' && currentUser.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can invite admin users' });
    }

    // Check if user already exists in the org
    const { data: existingUser, error: existingUserErr } = await supabase
      .from('User')
      .select('id')
      .eq('email', email)
      .eq('organizationId', orgId)
      .maybeSingle();

    log.info('Existing user check', { existingUser, error: existingUserErr?.message });

    if (existingUser) {
      return res.status(400).json({
        error: `${email} is already on the team.`,
        code: 'INVITE_ALREADY_MEMBER',
      });
    }

    // Check for an existing live (unexpired) pending invitation
    if (await hasLivePendingInvite(email, orgId)) {
      return res.status(400).json({
        error: `${email} already has a pending invitation.`,
        code: 'INVITE_ALREADY_PENDING',
      });
    }

    // Create invitation
    const token = generateToken();
    const expiresAt = getExpirationDate();

    log.info('Inserting invitation record', { email, organizationId: orgId, role });

    const { data: invitation, error: insertError } = await supabase
      .from('Invitation')
      .insert({
        email,
        firmName: orgName,
        organizationId: orgId,
        role,
        invitedBy: currentUser.id,
        token,
        expiresAt: expiresAt.toISOString(),
        status: 'PENDING',
      })
      .select()
      .single();

    if (insertError) {
      log.error('Invitation insert error', insertError);
      throw insertError;
    }

    // Send invitation email
    const emailResult = await sendInvitationEmail(
      email,
      currentUser.name || 'A team member',
      orgName,
      token,
      role,
      req
    );

    if (!emailResult.success) {
      log.warn('Email send failed but invitation created', { error: emailResult.error });
    }

    // Build invite URL for fallback sharing — same origin as the inviter's session
    const baseUrl = resolveBaseUrl(req);
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;

    // Audit log
    await AuditLog.log(req, {
      action: 'INVITATION_SENT',
      resourceType: 'Invitation',
      resourceId: invitation.id,
      metadata: { email, role, organizationId: orgId },
    });

    // Onboarding: mark inviteTeamMember step complete (fire-and-forget)
    if (req.user?.id) {
      const onboardingUserId = req.user.id;
      void import('./onboarding.js').then(({ tryCompleteOnboardingStep }) => tryCompleteOnboardingStep(onboardingUserId, 'inviteTeamMember'));
    }

    res.status(201).json({
      ...invitation,
      emailSent: emailResult.success,
      emailError: emailResult.success ? undefined : emailResult.error,
      // Always return inviteUrl so the inviter can copy/share manually,
      // even when the email was sent successfully.
      inviteUrl,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/invitations/bulk - Send multiple invitations
router.post('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user;
    const orgId = getOrgId(req);
    const validation = bulkInviteSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
    }

    if (!user?.id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { role } = validation.data;
    const invites: { email: string; dealId?: string | null }[] =
      validation.data.invites ?? (validation.data.emails ?? []).map((email) => ({ email }));
    const emails = invites.map((i) => i.email);

    // Every deal named in the file must belong to this org.
    const dealIds = [...new Set(invites.map((i) => i.dealId).filter((d): d is string => !!d))];
    if (dealIds.length > 0) {
      const { data: deals } = await supabase.from('Deal').select('id').eq('organizationId', orgId).in('id', dealIds);
      const known = new Set((deals ?? []).map((d: { id: string }) => d.id));
      const unknown = dealIds.filter((d) => !known.has(d));
      if (unknown.length > 0) return res.status(400).json({ error: 'One or more deals were not found', dealIds: unknown });
    }

    // Get current user's info
    const { data: currentUser, error: userError } = await supabase
      .from('User')
      .select('id, name, firmName, organizationId, role')
      .eq('authId', user.id)
      .maybeSingle();

    if (userError) throw userError;
    if (!currentUser) {
      return res.status(400).json({ error: 'User profile not found' });
    }

    if (!currentUser?.organizationId) {
      return res.status(400).json({ error: 'You must belong to an organization to invite members' });
    }

    // Get org name for email
    const { data: org } = await supabase
      .from('Organization')
      .select('name')
      .eq('id', orgId)
      .single();

    const orgName = org?.name || currentUser.firmName || 'your organization';

    const results: {
      email: string;
      status: 'sent' | 'exists' | 'pending' | 'error';
      error?: string;
      /** Deal handling for this row: added now (existing member), saved for accept, or not saved. */
      deal?: 'added' | 'on_accept' | 'not_saved';
    }[] = [];

    for (const { email, dealId } of invites) {
      try {
        // Check if user already exists in org
        const { data: existingUser } = await supabase
          .from('User')
          .select('id')
          .eq('email', email)
          .eq('organizationId', orgId)
          .maybeSingle();

        if (existingUser) {
          // Already a member: put them on the deal right away.
          if (dealId) {
            const { data: onTeam } = await supabase
              .from('DealTeamMember').select('id').eq('dealId', dealId).eq('userId', existingUser.id).maybeSingle();
            if (!onTeam) await supabase.from('DealTeamMember').insert({ dealId, userId: existingUser.id, role: 'MEMBER' });
            results.push({ email, status: 'exists', deal: 'added' });
          } else {
            results.push({ email, status: 'exists' });
          }
          continue;
        }

        // Check for a live (unexpired) pending invitation
        if (await hasLivePendingInvite(email, orgId)) {
          results.push({ email, status: 'pending' });
          continue;
        }

        // Create invitation
        const token = generateToken();
        const expiresAt = getExpirationDate();

        const row: Record<string, unknown> = {
          email,
          firmName: orgName,
          organizationId: orgId,
          role,
          invitedBy: currentUser.id,
          token,
          expiresAt: expiresAt.toISOString(),
          status: 'PENDING',
        };
        let dealOutcome: 'on_accept' | 'not_saved' | undefined;
        let { error: insertError } = await supabase.from('Invitation').insert(dealId ? { ...row, dealId } : row);
        if (insertError && dealId && (insertError.code === '42703' || insertError.code === 'PGRST204')) {
          // invitation-deal-migration.sql not run yet — send without the deal.
          log.warn('Invitation.dealId column missing — run invitation-deal-migration.sql');
          ({ error: insertError } = await supabase.from('Invitation').insert(row));
          dealOutcome = 'not_saved';
        } else if (dealId) {
          dealOutcome = 'on_accept';
        }

        if (insertError) throw insertError;

        // Send email
        await sendInvitationEmail(
          email,
          currentUser.name || 'A team member',
          orgName,
          token,
          role,
          req
        );

        results.push(dealOutcome ? { email, status: 'sent', deal: dealOutcome } : { email, status: 'sent' });
      } catch (error) {
        results.push({ email, status: 'error', error: 'Failed to process' });
      }
    }

    res.json({
      total: emails.length,
      sent: results.filter(r => r.status === 'sent').length,
      results,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

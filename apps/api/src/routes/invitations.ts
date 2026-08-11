import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { Resend } from 'resend';
import { supabase } from '../supabase.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

// Sub-routers
import invitationsAcceptRouter from './invitations-accept.js';

const router = Router();

// Initialize Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Validation schemas
const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

const bulkInviteSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(20),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).default('MEMBER'),
});

// Helper: Generate secure token
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Helper: Get expiration date (7 days from now)
export function getExpirationDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date;
}

// Resolve the public base URL the invite link should point to. Prefers the
// caller's Origin header (so a preview-deployment admin gets links back to
// THEIR preview, and a prod admin gets prod links) over the static APP_URL
// env var. Falls back to APP_URL, then localhost for dev.
function resolveBaseUrl(req?: Request): string {
  const origin = req?.headers?.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/$/, '');
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  return 'http://localhost:3000';
}

// Helper: Send invitation email via Resend
export async function sendInvitationEmail(
  email: string,
  inviterName: string,
  firmName: string,
  token: string,
  role: string,
  req?: Request
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = resolveBaseUrl(req);
    const inviteUrl = `${baseUrl}/accept-invite?token=${token}`;

    log.info('Sending invitation email', { email, inviterName, firmName, role, inviteUrl });

    if (!resend) {
      log.warn('Resend not configured — RESEND_API_KEY missing. Invitation URL logged above.');
      return { success: false, error: 'Email service not configured (RESEND_API_KEY missing)' };
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

    const { data, error } = await resend.emails.send({
      from: `PE OS <${fromEmail}>`,
      to: [email],
      subject: `You're invited to join ${firmName} on PE OS`,
      html: `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
          <div style="background: linear-gradient(135deg, #003366, #0055aa); padding: 32px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">PE OS</h1>
            <p style="color: #b3d1ff; margin: 8px 0 0; font-size: 14px;">AI-Powered Private Equity CRM</p>
          </div>
          <div style="padding: 32px;">
            <h2 style="color: #003366; margin: 0 0 16px; font-size: 20px;">You're Invited! 🎉</h2>
            <p style="color: #333; font-size: 16px; line-height: 1.6;">
              <strong>${inviterName}</strong> has invited you to join <strong>${firmName}</strong> on PE OS.
            </p>
            <p style="color: #555; font-size: 15px; line-height: 1.6;">
              You've been assigned the role of <strong>${role}</strong>. Click the button below to create your account and get started.
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${inviteUrl}"
                 style="background: linear-gradient(135deg, #003366, #0055aa); color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 16px; font-weight: 600; letter-spacing: 0.5px;">
                Accept Invitation
              </a>
            </div>
            <p style="color: #888; font-size: 13px; text-align: center;">This invitation expires in 7 days.</p>
          </div>
          <hr style="border: none; border-top: 1px solid #eef2f7; margin: 0;" />
          <div style="padding: 20px 32px; text-align: center;">
            <p style="color: #aaa; font-size: 12px; margin: 0;">
              PE OS — AI-Powered Private Equity CRM<br/>
              If you didn't expect this invitation, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      log.error('Resend email error', error);
      return { success: false, error: error.message || 'Failed to send email' };
    }

    log.info('Invitation email sent successfully', { email, messageId: data?.id });
    return { success: true };
  } catch (error) {
    log.error('Email send error', error);
    return { success: false, error: 'Failed to send invitation email' };
  }
}

// Mount sub-routers
router.use('/', invitationsAcceptRouter);

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

    // Decorate with full invite URL for pending invites; strip token from accepted/expired
    const baseUrl = resolveBaseUrl(req);
    const decorated = (invitations || []).map((inv: any) => {
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

    // Check for existing pending invitation
    const { data: existingInvite, error: existingInviteErr } = await supabase
      .from('Invitation')
      .select('id')
      .eq('email', email)
      .eq('organizationId', orgId)
      .eq('status', 'PENDING')
      .maybeSingle();

    log.info('Existing invite check', { existingInvite, error: existingInviteErr?.message });

    if (existingInvite) {
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

    const { emails, role } = validation.data;

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

    const results: { email: string; status: 'sent' | 'exists' | 'pending' | 'error'; error?: string }[] = [];

    for (const email of emails) {
      try {
        // Check if user already exists in org
        const { data: existingUser } = await supabase
          .from('User')
          .select('id')
          .eq('email', email)
          .eq('organizationId', orgId)
          .maybeSingle();

        if (existingUser) {
          results.push({ email, status: 'exists' });
          continue;
        }

        // Check for pending invitation
        const { data: existingInvite } = await supabase
          .from('Invitation')
          .select('id')
          .eq('email', email)
          .eq('organizationId', orgId)
          .eq('status', 'PENDING')
          .maybeSingle();

        if (existingInvite) {
          results.push({ email, status: 'pending' });
          continue;
        }

        // Create invitation
        const token = generateToken();
        const expiresAt = getExpirationDate();

        const { error: insertError } = await supabase
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
          });

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

        results.push({ email, status: 'sent' });
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

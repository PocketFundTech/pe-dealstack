import { supabase } from '../supabase.js';

/**
 * Who may write the organization's firm profile (Organization.settings.firmProfile)?
 *
 * The firm profile is org-wide: every teammate's AI findings are tailored to it.
 * An invited teammate running the onboarding checklist used to be able to
 * overwrite what the founder set up. The rule:
 *   - org ADMINs and the org's founding user (Organization.createdBy) may always edit;
 *   - anyone may set it while the org has no firm profile yet;
 *   - legacy orgs with no createdBy fall back to "allowed unless the user joined
 *     via an invitation" so pre-createdBy founders aren't locked out.
 */
export interface FirmProfileAccess {
  role: string | null;
  isFounder: boolean;
  /** The user joined someone else's org (invite link or not the founder). */
  invited: boolean;
  firmProfileSet: boolean;
  canEditFirmProfile: boolean;
}

interface AuthUserLike {
  id: string;
  user_metadata?: Record<string, unknown>;
}

export function hasFirmProfile(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, unknown>;
  const profile = s.firmProfile;
  if (!profile || typeof profile !== 'object') return false;
  return Object.values(profile as Record<string, unknown>).some((v) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

export async function getFirmProfileAccess(
  authUser: AuthUserLike,
  orgId: string,
): Promise<FirmProfileAccess> {
  const [{ data: user }, { data: org }] = await Promise.all([
    supabase.from('User').select('id, role').eq('authId', authUser.id).maybeSingle(),
    supabase.from('Organization').select('createdBy, settings').eq('id', orgId).maybeSingle(),
  ]);

  const role = (user?.role as string | undefined) ?? null;
  const createdBy = (org?.createdBy as string | null | undefined) ?? null;
  const isFounder = !!user?.id && !!createdBy && createdBy === user.id;
  const invitedMetadata = authUser.user_metadata?.invited === true;
  const invited = invitedMetadata || (!!createdBy && !isFounder && role !== 'ADMIN');
  const firmProfileSet = hasFirmProfile(org?.settings);

  const canEditFirmProfile =
    role === 'ADMIN' ||
    isFounder ||
    !firmProfileSet ||
    (!createdBy && !invitedMetadata);

  return { role, isFounder, invited, firmProfileSet, canEditFirmProfile };
}

export const FIRM_PROFILE_LOCKED = {
  error: "Your firm's profile is managed by your workspace admin.",
  code: 'FIRM_PROFILE_LOCKED',
} as const;

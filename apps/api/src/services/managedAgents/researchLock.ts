import { supabase } from '../../supabase.js';

const STALE_LOCK_MS = 10 * 60 * 1000;

export async function acquireResearchLock(organizationId: string): Promise<boolean> {
  const now = new Date().toISOString();

  const freshAttempt = await supabase
    .from('Organization')
    .update({ researchLockedAt: now })
    .eq('id', organizationId)
    .is('researchLockedAt', null)
    .select();
  if (freshAttempt.data && freshAttempt.data.length > 0) return true;

  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const staleAttempt = await supabase
    .from('Organization')
    .update({ researchLockedAt: now })
    .eq('id', organizationId)
    .lt('researchLockedAt', staleThreshold)
    .select();

  return Boolean(staleAttempt.data && staleAttempt.data.length > 0);
}

export async function releaseResearchLock(organizationId: string): Promise<void> {
  await supabase.from('Organization').update({ researchLockedAt: null }).eq('id', organizationId);
}

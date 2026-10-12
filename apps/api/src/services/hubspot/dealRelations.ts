import { supabase } from '../../supabase.js';
import type { ImportMode } from './dedup.js';
import type { HubSpotOwner } from './types.js';

/**
 * Link contacts to a deal (ContactDeal). Existing links — including any role a
 * user picked — are left untouched. Returns how many links are new.
 */
export async function linkDealContacts(dealId: string, contactIds: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const rows = contactIds.map((contactId) => ({ contactId, dealId, role: 'OTHER' }));
  const { data, error } = await supabase
    .from('ContactDeal')
    .upsert(rows, { onConflict: 'contactId,dealId', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`ContactDeal link failed: ${(error as { message?: string }).message ?? 'unknown error'}`);
  return (data as unknown[] | null)?.length ?? 0;
}

/** The org's users keyed by lower-cased email → internal User.id. */
export async function loadOrgUsersByEmail(orgId: string): Promise<Map<string, string>> {
  const { data } = await supabase.from('User').select('id, email').eq('organizationId', orgId);
  const map = new Map<string, string>();
  for (const u of (data ?? []) as Array<{ id: string; email: string | null }>) {
    if (u.email) map.set(u.email.trim().toLowerCase(), u.id);
  }
  return map;
}

export type OwnerResult = 'set' | 'already' | 'kept_existing' | 'no_match';

/**
 * Make the HubSpot owner the deal's Lead Partner — the same effect as adding
 * them with role LEAD via POST /deals/:id/team (Deal.assignedTo + a LEAD
 * DealTeamMember). Fill mode never replaces a Lead Partner someone set in Avise.
 */
export async function applyDealOwner(params: {
  dealId: string;
  orgId: string;
  ownerUserId: string | null;
  mode: ImportMode;
}): Promise<OwnerResult> {
  const { dealId, orgId, ownerUserId, mode } = params;
  if (!ownerUserId) return 'no_match';

  const { data: deal } = await supabase.from('Deal').select('assignedTo').eq('id', dealId).eq('organizationId', orgId).maybeSingle();
  const current = (deal as { assignedTo?: string | null } | null)?.assignedTo ?? null;
  if (current === ownerUserId) return 'already';
  if (current && mode === 'fill') return 'kept_existing';

  await supabase.from('Deal')
    .update({ assignedTo: ownerUserId, updatedAt: new Date().toISOString() })
    .eq('id', dealId)
    .eq('organizationId', orgId);

  const { data: member } = await supabase
    .from('DealTeamMember').select('id, role').eq('dealId', dealId).eq('userId', ownerUserId).maybeSingle();
  const existing = member as { id: string; role?: string | null } | null;
  if (!existing) {
    await supabase.from('DealTeamMember').insert({ dealId, userId: ownerUserId, role: 'LEAD' });
  } else if (existing.role !== 'LEAD') {
    await supabase.from('DealTeamMember').update({ role: 'LEAD' }).eq('id', existing.id);
  }
  return 'set';
}

/** "Name <email>" for the deal's HubSpot card, with sensible fallbacks. */
export function ownerLabel(o: HubSpotOwner): string {
  if (o.name && o.email) return `${o.name} <${o.email}>`;
  return o.name ?? o.email ?? `HubSpot owner ${o.id}`;
}

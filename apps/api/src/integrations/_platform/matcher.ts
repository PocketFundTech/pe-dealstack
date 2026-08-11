import { supabase } from '../../supabase.js';

export interface MatchResult {
  matchedContactIds: string[];
  matchedDealIds: string[];
}

export async function matchEmailAddressesToDeals(params: {
  organizationId: string;
  emails: string[];
}): Promise<MatchResult> {
  const normalized = Array.from(
    new Set(params.emails.map(e => e.trim().toLowerCase()).filter(Boolean))
  );
  if (normalized.length === 0) return { matchedContactIds: [], matchedDealIds: [] };

  const { data: contacts, error: contactErr } = await supabase
    .from('Contact')
    .select('id, email')
    .in('email', normalized)
    .eq('organizationId', params.organizationId);
  if (contactErr) throw new Error(`matcher: contact lookup failed: ${contactErr.message}`);

  const matchedContactIds = (contacts ?? [])
    .filter((c: { email: string | null }) => c.email && normalized.includes(c.email.toLowerCase()))
    .map((c: { id: string }) => c.id);
  if (matchedContactIds.length === 0) return { matchedContactIds: [], matchedDealIds: [] };

  const { data: links, error: linkErr } = await supabase
    .from('ContactDeal')
    .select('dealId')
    .in('contactId', matchedContactIds);
  if (linkErr) throw new Error(`matcher: deal link lookup failed: ${linkErr.message}`);

  const matchedDealIds = Array.from(
    new Set((links ?? []).map((l: { dealId: string }) => l.dealId).filter(Boolean))
  );

  return { matchedContactIds, matchedDealIds };
}

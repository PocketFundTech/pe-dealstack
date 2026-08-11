// Outlook's OWN deal-creation + contact-linking. Deliberately self-contained:
// it reuses only shared services (aiExtractor, dealMerger icon helper, the
// Company/Deal/Contact tables) — NOTHING from the Gmail integration — so the
// two providers stay fully independent.

import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { extractDealDataFromText } from '../../services/aiExtractor.js';
import { getIconForIndustry } from '../../services/dealMerger.js';

const MIN_BODY_CHARS = 100;
// Per-field confidence floor — drop low-confidence numbers before persisting so
// a weak extraction can't corrupt the deal row (mirrors the manual-ingest floor).
const FIELD_FLOOR = 60;

function gatedNumber(
  field: { value: number | null; confidence: number } | null | undefined
): number | null {
  if (!field || field.value == null) return null;
  return field.confidence >= FIELD_FLOOR ? field.value : null;
}

function buildDealText(email: { subject: string; from: string; date: Date; bodyText: string }): string {
  return [
    `Subject: ${email.subject}`,
    `From: ${email.from}`,
    `Date: ${email.date.toISOString().split('T')[0]}`,
    '---',
    '',
    email.bodyText,
  ].join('\n');
}

export interface OutlookDealResult {
  created: boolean;
  dealId?: string;
  companyName?: string;
  reason?: 'duplicate' | 'existing_company_deal' | 'insufficient_content' | 'extraction_failed' | 'no_company_name';
}

/**
 * Create a Deal from an Outlook email when no existing deal matched.
 * Idempotent on (organizationId, sourceMessageId); also attaches to an existing
 * deal for the same company instead of creating a duplicate. Returns the dealId
 * in every "found-or-created" case so the caller can link the email + contact.
 */
export async function createDealFromOutlookEmail(params: {
  organizationId: string;
  userId: string | null;
  email: { subject: string; from: string; date: Date; bodyText: string };
  messageId?: string | null;
  conversationId?: string | null;
}): Promise<OutlookDealResult> {
  const { organizationId, email, messageId, conversationId } = params;

  // 1. Idempotency — same email already turned into a deal?
  if (messageId) {
    const { data: dup } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', organizationId)
      .eq('sourceMessageId', messageId)
      .maybeSingle();
    if (dup?.id) return { created: false, reason: 'duplicate', dealId: dup.id };
  }

  if (email.bodyText.trim().length < MIN_BODY_CHARS) {
    return { created: false, reason: 'insufficient_content' };
  }

  // 2. Extract deal fields (shared service).
  const aiData = await extractDealDataFromText(buildDealText(email));
  if (!aiData) return { created: false, reason: 'extraction_failed' };
  const companyName = aiData.companyName.value;
  if (!companyName) return { created: false, reason: 'no_company_name' };

  // 3. Find-or-create Company (case-insensitive within org).
  const { data: existingCompany } = await supabase
    .from('Company')
    .select('id')
    .ilike('name', companyName)
    .eq('organizationId', organizationId)
    .maybeSingle();

  let companyId: string;
  if (existingCompany?.id) {
    companyId = existingCompany.id;
  } else {
    const { data: newCompany, error } = await supabase
      .from('Company')
      .insert({
        name: companyName,
        industry: aiData.industry.value,
        description: aiData.description.value,
        organizationId,
      })
      .select('id')
      .single();
    if (error || !newCompany) {
      throw new Error(`outlook createDeal: company insert failed — ${error?.message ?? 'no row'}`);
    }
    companyId = newCompany.id;
  }

  // 4. If a deal already exists for this company, attach to it (don't duplicate).
  const { data: existingDeal } = await supabase
    .from('Deal')
    .select('id')
    .eq('organizationId', organizationId)
    .eq('companyId', companyId)
    .maybeSingle();
  if (existingDeal?.id) {
    return { created: false, reason: 'existing_company_deal', dealId: existingDeal.id };
  }

  // 5. Create the Deal.
  const dealRow: Record<string, unknown> = {
    name: companyName,
    companyId,
    organizationId,
    stage: 'INITIAL_REVIEW',
    // Always ACTIVE so the auto-created deal shows in the Deals list
    // (which filters to status=ACTIVE). The needsReview flag below is still
    // set, so it stays marked for review without being hidden.
    status: 'ACTIVE',
    industry: aiData.industry.value,
    description: aiData.description.value,
    revenue: gatedNumber(aiData.revenue),
    ebitda: gatedNumber(aiData.ebitda),
    dealSize: gatedNumber(aiData.dealSize),
    aiThesis: aiData.summary,
    icon: getIconForIndustry(aiData.industry.value),
    extractionConfidence: aiData.overallConfidence,
    needsReview: aiData.needsReview,
    reviewReasons: aiData.reviewReasons,
    aiRisks: {
      keyRisks: aiData.keyRisks || [],
      investmentHighlights: aiData.investmentHighlights || [],
    },
    source: 'ai_email_outlook',
    sourceConfidence: aiData.overallConfidence,
    sourceMessageId: messageId ?? null,
    sourceThreadIds: conversationId ? [conversationId] : [],
  };

  const { data: deal, error: dealError } = await supabase
    .from('Deal')
    .insert(dealRow)
    .select('id')
    .single();

  if (dealError || !deal) {
    // Race with a parallel sync on the unique (organizationId, sourceMessageId).
    if (dealError?.code === '23505' && messageId) {
      const { data: dup } = await supabase
        .from('Deal')
        .select('id')
        .eq('organizationId', organizationId)
        .eq('sourceMessageId', messageId)
        .maybeSingle();
      if (dup?.id) return { created: false, reason: 'duplicate', dealId: dup.id };
    }
    throw new Error(`outlook createDeal: deal insert failed — ${dealError?.message ?? 'no row'}`);
  }

  return { created: true, dealId: deal.id, companyName };
}

/**
 * Find-or-create a Contact by email and link it to a deal. Best-effort: logs and
 * returns null on failure rather than breaking the sync. Returns the contactId.
 */
export async function ensureContactOnDeal(params: {
  organizationId: string;
  dealId: string;
  email: string;
  name: string | null;
}): Promise<string | null> {
  const { organizationId, dealId } = params;
  const email = params.email.trim().toLowerCase();
  if (!email) return null;

  try {
    let contactId: string;
    const { data: existing } = await supabase
      .from('Contact')
      .select('id')
      .eq('organizationId', organizationId)
      .ilike('email', email)
      .maybeSingle();

    if (existing?.id) {
      contactId = existing.id;
    } else {
      const local = email.split('@')[0];
      const parts = (params.name?.trim() || local).split(/\s+/);
      const firstName = parts[0] || local;
      const lastName = parts.slice(1).join(' ') || '—';
      const { data: newContact, error } = await supabase
        .from('Contact')
        .insert({ organizationId, firstName, lastName, email, type: 'OTHER' })
        .select('id')
        .single();
      if (error || !newContact) {
        log.warn('outlook: contact create failed', { email, err: error?.message });
        return null;
      }
      contactId = newContact.id;
    }

    const { error: linkErr } = await supabase
      .from('ContactDeal')
      .insert({ contactId, dealId, role: 'OTHER' });
    // 23505 = already linked; that's fine.
    if (linkErr && linkErr.code !== '23505') {
      log.warn('outlook: contact-deal link failed', { contactId, dealId, err: linkErr.message });
    }
    return contactId;
  } catch (err) {
    log.warn('outlook: ensureContactOnDeal threw', { email, err: (err as Error).message });
    return null;
  }
}

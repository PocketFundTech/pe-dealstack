import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import {
  runDealIncrementalUpdate,
  type DealSnapshot,
  type DealIncrementalUpdate,
  SENSITIVE_FIELDS,
} from '../../services/agents/dealIncrementalUpdate/index.js';

// Default confidence threshold for auto-applying non-sensitive field changes.
// Sensitive fields ignore this and ALWAYS land in DealUpdateProposal.
const DEFAULT_NON_SENSITIVE_THRESHOLD = 0.8;

// Window during which a recent human edit blocks AI overwrites of any field.
const HUMAN_EDIT_LOCKOUT_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoUpdateDealInput {
  dealId: string;
  organizationId: string;
  email: {
    subject: string;
    from: string;
    date: string;
    bodyText: string;
    messageId: string | null;
    threadId: string | null;
  };
  integrationActivityId: string | null;
  // Per-org threshold for non-sensitive auto-apply. Falls back to default.
  nonSensitiveThreshold?: number;
}

export interface AutoUpdateDealResult {
  ran: boolean;
  applied: string[];          // field names that were auto-applied
  proposed: string[];         // field names that became DealUpdateProposal rows
  contactsAdded: number;
  reason?: 'no_llm_output' | 'deal_not_found' | 'no_changes';
}

interface DealRow {
  id: string;
  organizationId: string;
  name: string;
  stage: string | null;
  industry: string | null;
  description: string | null;
  revenue: number | null;
  ebitda: number | null;
  dealSize: number | null;
  aiThesis: string | null;
  aiRisks: { keyRisks?: string[]; investmentHighlights?: string[] } | null;
  updatedAt: string | null;
  sourceThreadIds: string[] | null;
}

async function loadDealSnapshot(dealId: string, organizationId: string): Promise<{
  row: DealRow;
  snapshot: DealSnapshot;
} | null> {
  const { data: deal } = await supabase
    .from('Deal')
    .select(
      'id, organizationId, name, stage, industry, description, revenue, ebitda, dealSize, aiThesis, aiRisks, updatedAt, sourceThreadIds'
    )
    .eq('id', dealId)
    .eq('organizationId', organizationId)
    .maybeSingle();
  if (!deal) return null;

  // Existing contacts on the deal — passed to the agent so it doesn't propose
  // adding people we already track. supabase types the embedded relation as
  // an array even when the FK is single-row, so we normalise to both shapes.
  const { data: links } = await supabase
    .from('ContactDeal')
    .select('Contact:contactId(email)')
    .eq('dealId', dealId);
  type RelEmail = { email: string | null };
  const existingContactEmails = (((links ?? []) as unknown) as Array<{ Contact?: RelEmail | RelEmail[] | null }>)
    .flatMap(l => {
      const c = l.Contact;
      if (!c) return [];
      return Array.isArray(c) ? c : [c];
    })
    .map(c => c.email)
    .filter((e): e is string => !!e)
    .map(e => e.toLowerCase());

  const row = deal as DealRow;
  return {
    row,
    snapshot: {
      id: row.id,
      name: row.name,
      stage: row.stage,
      industry: row.industry,
      description: row.description,
      revenue: row.revenue,
      ebitda: row.ebitda,
      dealSize: row.dealSize,
      aiThesis: row.aiThesis,
      keyRisks: row.aiRisks?.keyRisks ?? [],
      investmentHighlights: row.aiRisks?.investmentHighlights ?? [],
      existingContactEmails,
    },
  };
}

// Human-edit lockout: if the Deal row was touched in the last N days, we don't
// know whether the edit was AI or human, so we conservatively queue everything.
// (A finer-grained per-field human/AI provenance would need an Activity-log
// scan — out of scope for this round.)
function isLockedOutByRecentEdit(deal: DealRow): boolean {
  if (!deal.updatedAt) return false;
  const ms = Date.parse(deal.updatedAt);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms < HUMAN_EDIT_LOCKOUT_MS;
}

async function recordProposal(params: {
  dealId: string;
  organizationId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  confidence: number;
  sourceQuote: string;
  sourceActivityId: string | null;
}): Promise<void> {
  const { error } = await supabase.from('DealUpdateProposal').insert({
    dealId: params.dealId,
    organizationId: params.organizationId,
    field: params.field,
    oldValue: params.oldValue ?? null,
    newValue: params.newValue ?? null,
    confidence: params.confidence,
    sourceQuote: params.sourceQuote,
    sourceActivityId: params.sourceActivityId,
    status: 'pending',
  });
  if (error) {
    log.warn('autoUpdateDeal: proposal insert failed', {
      field: params.field,
      message: error.message,
    });
  }
}

async function appendThreadId(dealId: string, currentThreadIds: string[] | null, threadId: string): Promise<void> {
  const ids = currentThreadIds ?? [];
  if (ids.includes(threadId)) return;
  await supabase
    .from('Deal')
    .update({ sourceThreadIds: [...ids, threadId] })
    .eq('id', dealId);
}

async function addContacts(params: {
  dealId: string;
  organizationId: string;
  contactsToAdd: DealIncrementalUpdate['contactsToAdd'];
}): Promise<number> {
  if (params.contactsToAdd.length === 0) return 0;
  let added = 0;
  for (const c of params.contactsToAdd) {
    const email = c.email.trim().toLowerCase();
    if (!email) continue;

    // Find-or-create Contact.
    const { data: existing } = await supabase
      .from('Contact')
      .select('id')
      .eq('email', email)
      .eq('organizationId', params.organizationId)
      .maybeSingle();

    let contactId = existing?.id as string | undefined;
    if (!contactId) {
      const { data: newContact, error } = await supabase
        .from('Contact')
        .insert({
          email,
          name: c.name ?? null,
          role: c.role ?? null,
          organizationId: params.organizationId,
          source: 'ai_email_gmail',
        })
        .select('id')
        .single();
      if (error || !newContact) {
        log.warn('autoUpdateDeal: contact insert failed', { email, error: error?.message });
        continue;
      }
      contactId = newContact.id;
    }

    // Link if not already linked.
    const { data: link } = await supabase
      .from('ContactDeal')
      .select('id')
      .eq('contactId', contactId)
      .eq('dealId', params.dealId)
      .maybeSingle();
    if (!link) {
      const { error: linkErr } = await supabase
        .from('ContactDeal')
        .insert({ contactId, dealId: params.dealId });
      if (linkErr) {
        log.warn('autoUpdateDeal: contactDeal link failed', {
          email,
          error: linkErr.message,
        });
        continue;
      }
      added++;
    }
  }
  return added;
}

/**
 * Runs the incremental-update agent against a known Deal and either auto-applies
 * non-sensitive changes or queues sensitive ones in DealUpdateProposal.
 *
 * Idempotency: same email body run twice will propose the same field changes
 * twice. We rely on the caller (sync engine) to gate by `IntegrationActivity`
 * uniqueness so this only fires once per (integration, message).
 */
export async function autoUpdateDealFromEmail(
  input: AutoUpdateDealInput
): Promise<AutoUpdateDealResult> {
  const loaded = await loadDealSnapshot(input.dealId, input.organizationId);
  if (!loaded) return { ran: false, applied: [], proposed: [], contactsAdded: 0, reason: 'deal_not_found' };

  const { row, snapshot } = loaded;

  const agentOutput = await runDealIncrementalUpdate({
    deal: snapshot,
    email: {
      subject: input.email.subject,
      from: input.email.from,
      date: input.email.date,
      bodyText: input.email.bodyText,
    },
  });
  if (!agentOutput) {
    return { ran: false, applied: [], proposed: [], contactsAdded: 0, reason: 'no_llm_output' };
  }

  const lockedOut = isLockedOutByRecentEdit(row);
  const threshold = input.nonSensitiveThreshold ?? DEFAULT_NON_SENSITIVE_THRESHOLD;

  const applied: string[] = [];
  const proposed: string[] = [];
  const directUpdate: Record<string, unknown> = {};

  // Field-by-field decision. Sensitive fields → proposal. Non-sensitive →
  // auto-apply IF confidence >= threshold AND no recent human edit.
  const fieldsWithProposals: Array<{
    field: keyof DealIncrementalUpdate;
    sensitive: boolean;
    oldVal: unknown;
  }> = [
    { field: 'dealSize', sensitive: true,  oldVal: snapshot.dealSize },
    { field: 'revenue',  sensitive: true,  oldVal: snapshot.revenue },
    { field: 'ebitda',   sensitive: true,  oldVal: snapshot.ebitda },
    { field: 'stage',    sensitive: true,  oldVal: snapshot.stage },
    { field: 'description', sensitive: false, oldVal: snapshot.description },
    { field: 'industry',    sensitive: false, oldVal: snapshot.industry },
  ];

  for (const { field, sensitive, oldVal } of fieldsWithProposals) {
    const proposal = agentOutput[field] as { value: unknown; confidence: number; sourceQuote: string } | null;
    if (!proposal) continue;

    if (sensitive || lockedOut) {
      await recordProposal({
        dealId: input.dealId,
        organizationId: input.organizationId,
        field: field as string,
        oldValue: oldVal,
        newValue: proposal.value,
        confidence: proposal.confidence,
        sourceQuote: proposal.sourceQuote,
        sourceActivityId: input.integrationActivityId,
      });
      proposed.push(field as string);
      continue;
    }

    if (proposal.confidence >= threshold) {
      (directUpdate as Record<string, unknown>)[field as string] = proposal.value;
      applied.push(field as string);
    } else {
      // Non-sensitive but low confidence → still queue so the user can see it.
      await recordProposal({
        dealId: input.dealId,
        organizationId: input.organizationId,
        field: field as string,
        oldValue: oldVal,
        newValue: proposal.value,
        confidence: proposal.confidence,
        sourceQuote: proposal.sourceQuote,
        sourceActivityId: input.integrationActivityId,
      });
      proposed.push(field as string);
    }
  }

  // thesisAppend: additive, non-sensitive — append text to aiThesis if confident
  // enough and not locked out.
  if (agentOutput.thesisAppend && !lockedOut && agentOutput.thesisAppend.confidence >= threshold) {
    const newThesis = (snapshot.aiThesis ?? '').trim();
    const appended = newThesis
      ? `${newThesis}\n\n[Update from ${input.email.date}] ${agentOutput.thesisAppend.value}`
      : agentOutput.thesisAppend.value;
    directUpdate.aiThesis = appended;
    applied.push('aiThesis');
  } else if (agentOutput.thesisAppend) {
    await recordProposal({
      dealId: input.dealId,
      organizationId: input.organizationId,
      field: 'thesisAppend',
      oldValue: snapshot.aiThesis,
      newValue: agentOutput.thesisAppend.value,
      confidence: agentOutput.thesisAppend.confidence,
      sourceQuote: agentOutput.thesisAppend.sourceQuote,
      sourceActivityId: input.integrationActivityId,
    });
    proposed.push('thesisAppend');
  }

  // Additive: aiRisks.keyRisks + aiRisks.investmentHighlights.
  // Append new bullets, dedupe by exact string match. Always auto-apply (additive
  // = low risk), but skip during human-edit lockout.
  const existingRisks = snapshot.keyRisks;
  const existingHighlights = snapshot.investmentHighlights;
  const addRisks = agentOutput.keyRisksAdd.filter(r => !existingRisks.includes(r));
  const addHighlights = agentOutput.investmentHighlightsAdd.filter(r => !existingHighlights.includes(r));

  if (!lockedOut && (addRisks.length > 0 || addHighlights.length > 0)) {
    directUpdate.aiRisks = {
      keyRisks: [...existingRisks, ...addRisks],
      investmentHighlights: [...existingHighlights, ...addHighlights],
    };
    if (addRisks.length > 0) applied.push('keyRisks');
    if (addHighlights.length > 0) applied.push('investmentHighlights');
  } else if (addRisks.length > 0 || addHighlights.length > 0) {
    // Locked out — surface as a single proposal row for visibility.
    await recordProposal({
      dealId: input.dealId,
      organizationId: input.organizationId,
      field: 'aiRisks',
      oldValue: { keyRisks: existingRisks, investmentHighlights: existingHighlights },
      newValue: { keyRisksAdd: addRisks, investmentHighlightsAdd: addHighlights },
      confidence: 0.8,
      sourceQuote: '(additive update during human-edit lockout)',
      sourceActivityId: input.integrationActivityId,
    });
    proposed.push('aiRisks');
  }

  // Append source thread + bump updatedAt only if we actually changed something.
  if (Object.keys(directUpdate).length > 0) {
    directUpdate.updatedAt = new Date().toISOString();
    const { error } = await supabase
      .from('Deal')
      .update(directUpdate)
      .eq('id', input.dealId)
      .eq('organizationId', input.organizationId);
    if (error) {
      log.error('autoUpdateDeal: deal update failed', error);
      // Don't throw — proposals (if any) were already written.
    }
  }

  if (input.email.threadId) {
    await appendThreadId(input.dealId, row.sourceThreadIds, input.email.threadId);
  }

  // Contacts are additive and low-risk → always apply (subject to lockout).
  const contactsAdded = lockedOut ? 0 : await addContacts({
    dealId: input.dealId,
    organizationId: input.organizationId,
    contactsToAdd: agentOutput.contactsToAdd,
  });

  // Activity log entry — visible in the deal's audit trail.
  if (applied.length > 0 || proposed.length > 0 || contactsAdded > 0) {
    await supabase.from('Activity').insert({
      dealId: input.dealId,
      type: 'DEAL_UPDATED',
      title: 'AI updated deal from new email',
      description: agentOutput.reasoning,
      metadata: {
        source: 'ai_email_gmail',
        emailMessageId: input.email.messageId,
        emailThreadId: input.email.threadId,
        emailFrom: input.email.from,
        applied,
        proposed,
        contactsAdded,
        sensitiveFields: Array.from(SENSITIVE_FIELDS),
        lockedOutByRecentEdit: lockedOut,
      },
    });
  } else {
    return { ran: true, applied: [], proposed: [], contactsAdded: 0, reason: 'no_changes' };
  }

  return { ran: true, applied, proposed, contactsAdded };
}

// ─── Contact Chat service ───────────────────────────────────────────
// Contact-scoped AI Q&A. Assembles a BOUNDED, org-scoped context for one
// contact — their CRM fields, recent interactions, linked deals, a short email
// summary, plus the firm's standing context — then runs ONE getChatModel call
// (with conversation history) and returns the assistant's reply.
//
// All sources are best-effort: any one failing is skipped, never fatal.

import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getChatModel } from './llm.js';
import { getFirmContextBlock } from './firmContextService.js';
import { getContactEmailSummary } from './gmailContactsService.js';

// ─── Tunables ──────────────────────────────────────────────────────
const MAX_INTERACTIONS = 15;
const MAX_LINKED_DEALS = 15;
const MAX_HISTORY_TURNS = 10; // most recent history messages threaded in
const CHAT_MAX_TOKENS = 1200;
const CAP_FIRM_CONTEXT = 3000;
const CAP_EMAIL_SUMMARY = 2000;
const CHAT_OPERATION = 'deal_analysis';

export interface ContactChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface ContactChatResult {
  response: string;
  model: string;
}

/**
 * Answer a question about a single (org-scoped) contact. Bounds every gathered
 * source, runs ONE LLM call with the supplied history, and returns the reply.
 * Caller is expected to have already verified contact access for the org.
 */
export async function chatAboutContact(
  orgId: string,
  contactId: string,
  message: string,
  history: ContactChatHistoryItem[] = [],
  authUserId?: string
): Promise<ContactChatResult> {
  const modelName = 'claude-sonnet-4-6';

  // 1. Contact fields (org-scoped).
  const { data: contact } = await supabase
    .from('Contact')
    .select('id, firstName, lastName, email, company, title, type, notes, lastContactedAt, organizationId')
    .eq('id', contactId)
    .eq('organizationId', orgId)
    .maybeSingle();

  if (!contact) {
    return {
      response: 'That contact could not be found in your organization.',
      model: modelName,
    };
  }

  const contactName =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'this contact';

  const contextSegments: string[] = [];

  const contactLines: string[] = [`Name: ${contactName}`];
  if (contact.type) contactLines.push(`Type: ${contact.type}`);
  if (contact.title) contactLines.push(`Title: ${contact.title}`);
  if (contact.company) contactLines.push(`Company: ${contact.company}`);
  if (contact.email) contactLines.push(`Email: ${contact.email}`);
  if (contact.lastContactedAt) contactLines.push(`Last contacted: ${contact.lastContactedAt}`);
  if (contact.notes) contactLines.push(`Notes: ${String(contact.notes).slice(0, 1000)}`);
  contextSegments.push(`## Contact\n${contactLines.join('\n')}`);

  // 2. Recent interactions (bounded). Best-effort.
  try {
    const { data: interactions } = await supabase
      .from('ContactInteraction')
      .select('type, title, description, date')
      .eq('contactId', contactId)
      .order('date', { ascending: false })
      .limit(MAX_INTERACTIONS);
    if (interactions && interactions.length > 0) {
      const lines = interactions.map((i: any) => {
        const segs = [i.date ? new Date(i.date).toISOString().slice(0, 10) : '', i.type || 'NOTE'];
        if (i.title) segs.push(i.title);
        const desc = (i.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const head = `- ${segs.filter(Boolean).join(' · ')}`;
        return desc ? `${head}: ${desc}` : head;
      });
      contextSegments.push(`## Recent Interactions\n${lines.join('\n')}`);
    }
  } catch (err) {
    log.warn('contactChat: interactions lookup failed', { contactId, err: String(err) });
  }

  // 3. Linked deals via ContactDeal → Deal (bounded). Best-effort.
  try {
    const { data: links } = await supabase
      .from('ContactDeal')
      .select('role, Deal:dealId(name, stage, status, industry)')
      .eq('contactId', contactId)
      .limit(MAX_LINKED_DEALS);
    if (links && links.length > 0) {
      const lines = links
        .map((l: any) => {
          const d = l.Deal;
          if (!d) return null;
          const segs = [d.name || 'Unnamed deal'];
          if (l.role) segs.push(`role: ${l.role}`);
          if (d.stage) segs.push(d.stage);
          if (d.status) segs.push(d.status);
          if (d.industry) segs.push(d.industry);
          return `- ${segs.join(' · ')}`;
        })
        .filter(Boolean);
      if (lines.length > 0) contextSegments.push(`## Linked Deals\n${lines.join('\n')}`);
    }
  } catch (err) {
    log.warn('contactChat: linked-deals lookup failed', { contactId, err: String(err) });
  }

  // 4. Short email summary (best-effort, bounded). Only when we can resolve a
  //    Gmail token via authUserId; otherwise skipped silently.
  if (authUserId) {
    try {
      const emailSummary = await getContactEmailSummary(orgId, contactId, authUserId);
      if (emailSummary.connected && emailSummary.summary) {
        const parts = [emailSummary.summary.slice(0, CAP_EMAIL_SUMMARY)];
        if (emailSummary.highlights.length > 0) {
          parts.push('Highlights:', ...emailSummary.highlights.map((h) => `- ${h}`));
        }
        contextSegments.push(`## Email Correspondence\n${parts.join('\n')}`);
      }
    } catch (err) {
      log.warn('contactChat: email summary failed (skipping)', { contactId, err: String(err) });
    }
  }

  // 5. Firm standing context (best-effort, bounded).
  try {
    const firmBlock = await getFirmContextBlock(orgId);
    if (firmBlock) {
      contextSegments.push(`## Firm Context\n${firmBlock.slice(0, CAP_FIRM_CONTEXT)}`);
    }
  } catch (err) {
    log.warn('contactChat: firm context failed (skipping)', { orgId, err: String(err) });
  }

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const systemPrompt = `You are an AI assistant for a private-equity firm, answering questions about a specific CRM contact. Use ONLY the context below; if the answer isn't in the context, say so plainly rather than inventing. Be concise and direct.

Today's date: ${today}

# Context for ${contactName}

${contextSegments.join('\n\n')}`;

  // Build the message list: system + trimmed history + the new user message.
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];
  const trimmedHistory = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];
  for (const turn of trimmedHistory) {
    if (!turn || typeof turn.content !== 'string' || !turn.content.trim()) continue;
    if (turn.role === 'assistant') messages.push(new AIMessage(turn.content));
    else messages.push(new HumanMessage(turn.content));
  }
  messages.push(new HumanMessage(message));

  try {
    const model = getChatModel(0.5, CHAT_MAX_TOKENS, CHAT_OPERATION);
    const result = await model.invoke(messages);
    const text =
      typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('')
          : '';
    return { response: (text || '').trim() || 'I could not generate a response.', model: modelName };
  } catch (err) {
    log.error('contactChat: LLM call failed', err, { contactId });
    throw err;
  }
}

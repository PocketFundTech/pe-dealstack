// ─── Smart Email Drafting Workflow ───────────────────────────────────
// LangGraph workflow: Draft → Tone Check → Compliance Check → Review
// Supports template library integration + human-in-the-loop review.

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { isLLMAvailable, invokeStructured } from '../../llm.js';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import { TOPIC_GUARDRAILS, CONTEXT_ANCHORING } from '../guardrails.js';
import { runWithAgentBounds } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// 4 sequential LLM calls (draft → tone → compliance → finalize). 30s
// covers all four; recursionLimit 10 is conservative for a fixed DAG.
const EMAIL_DRAFTER_TIMEOUT_MS = 30_000;
const EMAIL_DRAFTER_RECURSION_LIMIT = 10;

// ─── State Schema ──────────────────────────────────────────────────

const EmailState = Annotation.Root({
  // Input
  organizationId: Annotation<string>,
  dealId: Annotation<string | null>,
  contactId: Annotation<string | null>,
  purpose: Annotation<string>,
  context: Annotation<string>,
  templateId: Annotation<string | null>,
  tone: Annotation<string>,
  // Draft
  draft: Annotation<string>,
  subject: Annotation<string>,
  // Checks
  toneScore: Annotation<number>,
  toneNotes: Annotation<string[]>,
  complianceIssues: Annotation<string[]>,
  isCompliant: Annotation<boolean>,
  // Final
  finalDraft: Annotation<string>,
  suggestions: Annotation<string[]>,
  status: Annotation<string>,
  error: Annotation<string | null>,
});

// ─── Email Templates ──────────────────────────────────────────────

const EMAIL_TEMPLATES: Record<string, { name: string; structure: string }> = {
  initial_outreach: {
    name: 'Initial Deal Outreach',
    structure: 'Introduction > Why interested > Brief firm background > Proposed next step > Close',
  },
  follow_up: {
    name: 'Follow-Up After Meeting',
    structure: 'Thank for time > Key takeaways > Next steps discussed > Confirm timeline > Close',
  },
  document_request: {
    name: 'Due Diligence Document Request',
    structure: 'Reference deal stage > Specific documents needed > Format preferences > Timeline > Close',
  },
  loi_intro: {
    name: 'LOI Introduction',
    structure: 'Reference discussions > Outline key terms > Express commitment > Next steps > Close',
  },
  deal_update: {
    name: 'Deal Status Update',
    structure: 'Current status > Key developments > Decisions needed > Timeline > Close',
  },
  meeting_request: {
    name: 'Meeting Request',
    structure: 'Purpose > Proposed times > Attendees > Agenda topics > Close',
  },
  thank_you: {
    name: 'Thank You / Relationship Building',
    structure: 'Express gratitude > Reference specific interaction > Future opportunity > Close',
  },
};

// ─── Node: Draft Email ─────────────────────────────────────────────

async function draftNode(state: typeof EmailState.State) {
  const template = state.templateId ? EMAIL_TEMPLATES[state.templateId] : null;
  const templateGuide = template
    ? `\nUse this structure: ${template.structure}`
    : '';

  const result = await invokeStructured(z.object({
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Full email body with proper formatting'),
  }), [
    new SystemMessage(`You are an expert email writer for a Private Equity firm. Write professional, concise emails that are appropriate for PE deal communication.
${TOPIC_GUARDRAILS}
${CONTEXT_ANCHORING}

Tone: ${state.tone || 'professional'}${templateGuide}

Guidelines:
- Be direct and professional
- Include specific details from the context
- Keep paragraphs short (2-3 sentences max)
- Always include a clear call to action
- No jargon unless writing to another PE professional
- Sign off appropriately for the relationship stage`),
    new HumanMessage(`Write an email for this purpose: ${state.purpose}\n\nContext:\n${state.context}`),
  ], { maxTokens: 1500, temperature: 0.7, label: 'emailDrafter.draft' });

  return { draft: result.body, subject: result.subject };
}

// ─── Node: Tone Check ──────────────────────────────────────────────

async function toneCheckNode(state: typeof EmailState.State) {
  const result = await invokeStructured(z.object({
    score: z.number().min(0).max(100).describe('Tone appropriateness score'),
    notes: z.array(z.string()).describe('Specific tone feedback items'),
    adjustedDraft: z.string().describe('Adjusted email if score < 80, otherwise original'),
  }), [
    new SystemMessage(`You are an email tone analyzer for PE communications. Score the email's tone and provide feedback.

Evaluate:
- Professional tone (not too casual, not too stiff)
- Appropriate for the purpose and audience
- Confident but not aggressive
- Clear and direct
- No emotional language or pressure tactics

Target tone: ${state.tone || 'professional'}`),
    new HumanMessage(`Analyze this email's tone:\n\nSubject: ${state.subject}\n\n${state.draft}`),
  ], { maxTokens: 800, temperature: 0.2, label: 'emailDrafter.tone' });

  return {
    toneScore: result.score,
    toneNotes: result.notes,
    draft: result.score < 80 ? result.adjustedDraft : state.draft,
  };
}

// ─── Node: Compliance Check ────────────────────────────────────────

async function complianceCheckNode(state: typeof EmailState.State) {
  const result = await invokeStructured(z.object({
    isCompliant: z.boolean(),
    issues: z.array(z.string()).describe('Compliance issues found'),
    suggestions: z.array(z.string()).describe('Suggestions to improve the email'),
  }), [
    new SystemMessage(`You are a compliance checker for PE deal communications. Flag any potential issues.

Check for:
- Material non-public information (MNPI) disclosure
- Promissory or binding language that shouldn't be in an email
- Forward-looking statements without appropriate disclaimers
- Confidentiality concerns (sharing deal details externally)
- Regulatory concerns (FCPA, anti-bribery language)
- Missing confidentiality notice when needed
- Inappropriate commitments or promises`),
    new HumanMessage(`Check this email for compliance:\n\nPurpose: ${state.purpose}\nSubject: ${state.subject}\n\n${state.draft}`),
  ], { maxTokens: 800, temperature: 0.1, label: 'emailDrafter.compliance' });

  return {
    isCompliant: result.isCompliant,
    complianceIssues: result.issues,
    suggestions: result.suggestions,
  };
}

// ─── Node: Finalize ────────────────────────────────────────────────

async function finalizeNode(state: typeof EmailState.State) {
  return {
    finalDraft: state.draft,
    status: state.isCompliant ? 'ready_for_review' : 'compliance_issues',
  };
}

// ─── Graph Wiring ──────────────────────────────────────────────────

const graph = new StateGraph(EmailState)
  .addNode('writeDraft', draftNode)
  .addNode('toneCheck', toneCheckNode)
  .addNode('complianceCheck', complianceCheckNode)
  .addNode('finalize', finalizeNode)
  .addEdge(START, 'writeDraft')
  .addEdge('writeDraft', 'toneCheck')
  .addEdge('toneCheck', 'complianceCheck')
  .addEdge('complianceCheck', 'finalize')
  .addEdge('finalize', END);

const compiledGraph = graph.compile();

// ─── Public API ────────────────────────────────────────────────────

export interface EmailDraftInput {
  organizationId: string;
  dealId?: string | null;
  contactId?: string | null;
  purpose: string;
  context?: string;
  templateId?: string | null;
  tone?: string;
}

export interface EmailDraftResult {
  status: 'ready_for_review' | 'compliance_issues' | 'failed';
  subject: string;
  draft: string;
  toneScore: number;
  toneNotes: string[];
  complianceIssues: string[];
  isCompliant: boolean;
  suggestions: string[];
  error?: string | null;
}

/** List available email templates */
export function getEmailTemplates() {
  return Object.entries(EMAIL_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    structure: t.structure,
  }));
}

/** Generate a smart email draft with tone + compliance checks */
export async function generateEmailDraft(input: EmailDraftInput): Promise<EmailDraftResult> {
  if (!isLLMAvailable()) {
    return {
      status: 'failed',
      subject: '',
      draft: '',
      toneScore: 0,
      toneNotes: [],
      complianceIssues: [],
      isCompliant: false,
      suggestions: [],
      error: 'No LLM provider configured',
    };
  }

  // Build context from deal + contact if provided
  let context = input.context || '';

  if (input.dealId) {
    const { data: deal } = await supabase
      .from('Deal')
      .select('name, stage, industry, revenue, ebitda, dealSize, company:Company(name)')
      .eq('id', input.dealId)
      .single();

    if (deal) {
      const company = deal.company as any;
      context += `\nDeal: ${deal.name}, Stage: ${deal.stage}, Industry: ${deal.industry || 'N/A'}`;
      if (company) context += `, Company: ${company.name}`;
      if (deal.revenue) context += `, Revenue: $${deal.revenue}M`;
    }
  }

  if (input.contactId) {
    const { data: contact } = await supabase
      .from('Contact')
      .select('firstName, lastName, email, title, company')
      .eq('id', input.contactId)
      .single();

    if (contact) {
      context += `\nRecipient: ${contact.firstName} ${contact.lastName}`;
      if (contact.title) context += `, Title: ${contact.title}`;
      if (contact.company) context += `, Company: ${contact.company}`;
      if (contact.email) context += `, Email: ${contact.email}`;
    }
  }

  log.info('Generating email draft', { purpose: input.purpose, dealId: input.dealId });

  try {
    const result: any = await runWithAgentBounds(
      (config) =>
        compiledGraph.invoke(
          {
            organizationId: input.organizationId,
            dealId: input.dealId || null,
            contactId: input.contactId || null,
            purpose: input.purpose,
            context,
            templateId: input.templateId || null,
            tone: input.tone || 'professional',
            draft: '',
            subject: '',
            toneScore: 0,
            toneNotes: [],
            complianceIssues: [],
            isCompliant: true,
            finalDraft: '',
            suggestions: [],
            status: 'pending',
            error: null,
          },
          config,
        ),
      {
        timeoutMs: EMAIL_DRAFTER_TIMEOUT_MS,
        recursionLimit: EMAIL_DRAFTER_RECURSION_LIMIT,
        envVar: 'EMAIL_DRAFTER_TIMEOUT_MS',
        label: 'Email drafter agent',
      },
    );

    return {
      status: result.status as any,
      subject: result.subject,
      draft: result.finalDraft || result.draft,
      toneScore: result.toneScore,
      toneNotes: result.toneNotes,
      complianceIssues: result.complianceIssues,
      isCompliant: result.isCompliant,
      suggestions: result.suggestions,
    };
  } catch (error: any) {
    log.error('Email draft generation failed', error);
    return {
      status: 'failed',
      subject: '',
      draft: '',
      toneScore: 0,
      toneNotes: [],
      complianceIssues: [],
      isCompliant: false,
      suggestions: [],
      error: error.message,
    };
  }
}

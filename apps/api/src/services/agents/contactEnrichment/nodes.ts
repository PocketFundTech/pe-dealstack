// ─── Contact Enrichment Agent — LangGraph Nodes ─────────────────
// Node implementations: gather → research → validate → save | review

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { invokeStructured } from '../../llm.js';
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { EnrichmentState } from './state.js';
import { analyzeEmailDomain, scrapeCompanyWebsite, constructLinkedInUrl } from './helpers.js';
import { buildResearchPrompt, enrichmentSchema } from './prompts.js';
import { wrapDocumentContent } from '../guardrails.js';

// ─── Follow-up suggestion (SUGGESTION ONLY — never auto-writes followUpAt) ──
// Derives a recommended follow-up date + one-line action from interaction
// recency. Cadence: never-contacted → 3 days; cold (>90d) → tomorrow;
// warming (>30d) → 7 days; recent → 30 days.

export interface SuggestedFollowUp {
  date: string;   // ISO 8601 date of the suggested follow-up
  action: string; // one-line recommended action
}

export function computeSuggestedFollowUp(
  lastContactedAt: string | null | undefined,
  fullName: string,
): SuggestedFollowUp {
  const now = Date.now();
  const addDays = (d: number) => new Date(now + d * 86400000).toISOString();
  const name = fullName.trim() || 'this contact';

  if (!lastContactedAt) {
    return { date: addDays(3), action: `No interactions logged yet — reach out to ${name} to open the relationship.` };
  }

  const daysSince = Math.floor((now - new Date(lastContactedAt).getTime()) / 86400000);
  if (daysSince > 90) {
    return { date: addDays(1), action: `Last contact was ${daysSince} days ago — send a re-engagement note to ${name} before it goes cold.` };
  }
  if (daysSince > 30) {
    return { date: addDays(7), action: `It's been ${daysSince} days — schedule a check-in with ${name} within the week.` };
  }
  return { date: addDays(30), action: `Recently engaged (${daysSince} days ago) — plan a routine follow-up with ${name} in ~30 days.` };
}

// ─── Node 1: Gather CRM Data + External Intelligence ───────────────

export async function gatherNode(state: typeof EnrichmentState.State) {
  const steps = [...(state.steps || [])];
  steps.push({ timestamp: new Date().toISOString(), node: 'gather', message: 'Gathering intelligence from CRM + web' });

  const fullName = `${state.firstName} ${state.lastName}`;
  const emailAnalysis = analyzeEmailDomain(state.email);
  const companyLower = (state.company || emailAnalysis.companyFromDomain || '').toLowerCase();

  // Parallel fetch: documents, deals, notes, activities, company website, relationship proximity
  const [docResults, dealResults, noteResults, activityResults, websiteData, sameCompanyContacts] = await Promise.all([
    // 1. Search documents for mentions of this person's name or company
    (async () => {
      try {
        const { data } = await supabase
          .from('Document')
          .select('name, extractedText, dealId')
          .eq('organizationId', state.organizationId)
          .not('extractedText', 'is', null)
          .limit(50);

        if (!data) return [];
        const nameLower = fullName.toLowerCase();

        return data.filter(d => {
          const text = (d.extractedText || '').toLowerCase();
          return text.includes(nameLower) ||
            (companyLower && companyLower.length > 2 && text.includes(companyLower));
        }).map(d => {
          const text = d.extractedText || '';
          const nameLow = fullName.toLowerCase();
          const idx = text.toLowerCase().indexOf(nameLow);
          const searchIdx = idx >= 0 ? idx : text.toLowerCase().indexOf(companyLower);
          const start = Math.max(0, searchIdx - 300);
          const end = Math.min(text.length, searchIdx + 500);
          return { name: d.name, excerpt: text.slice(start, end), dealId: d.dealId };
        });
      } catch { return []; }
    })(),

    // 2. Find deals linked to this contact by company name match
    (async () => {
      try {
        const { data: deals } = await supabase
          .from('Deal')
          .select('id, name, stage, industry, revenue, ebitda')
          .eq('organizationId', state.organizationId);

        if (!deals || !companyLower || companyLower.length < 3) return [];

        return deals
          .filter(d => d.name.toLowerCase().includes(companyLower))
          .map(d => ({ name: d.name, stage: d.stage, industry: d.industry || 'N/A' }));
      } catch { return []; }
    })(),

    // 3. Get contact's existing notes, tags, LinkedIn
    (async () => {
      try {
        const { data } = await supabase
          .from('Contact')
          .select('notes, tags, linkedinUrl, lastContactedAt')
          .eq('id', state.contactId)
          .single();
        return data;
      } catch { return null; }
    })(),

    // 4. Search Activity table for interactions mentioning this contact
    (async () => {
      try {
        const { data } = await supabase
          .from('Activity')
          .select('type, title, description, createdAt, dealId')
          .eq('organizationId', state.organizationId)
          .order('createdAt', { ascending: false })
          .limit(100);

        if (!data) return [];
        const nameLower = fullName.toLowerCase();
        return data.filter(a => {
          const text = `${a.title} ${a.description || ''}`.toLowerCase();
          return text.includes(nameLower) ||
            (companyLower && companyLower.length > 2 && text.includes(companyLower));
        }).slice(0, 10);
      } catch { return []; }
    })(),

    // 5. Scrape company website for real data
    (async () => {
      const domain = emailAnalysis.domain;
      if (!domain || emailAnalysis.isPersonal) return null;
      return scrapeCompanyWebsite(domain);
    })(),

    // 6. Relationship proximity — other contacts at same company/domain
    (async () => {
      try {
        if (!companyLower || companyLower.length < 3) return [];
        const { data } = await supabase
          .from('Contact')
          .select('firstName, lastName, title, email')
          .eq('organizationId', state.organizationId)
          .neq('id', state.contactId)
          .ilike('company', `%${companyLower}%`)
          .limit(10);
        return data || [];
      } catch { return []; }
    })(),
  ]);

  // Build CRM context string for LLM
  const contextParts: string[] = [];

  // Email domain analysis
  if (emailAnalysis.domain && !emailAnalysis.isPersonal) {
    contextParts.push(`EMAIL ANALYSIS: Corporate email (${emailAnalysis.domain}). Company: ${emailAnalysis.companyFromDomain}`);
  } else if (emailAnalysis.isPersonal) {
    contextParts.push(`EMAIL ANALYSIS: Personal email (${emailAnalysis.domain}). No company from email.`);
  }

  // Company website data (REAL external data) — wrap raw page content
  // in <document> delimiters so the LLM treats it as untrusted data (Task 4.7).
  if (websiteData) {
    contextParts.push(`\nCOMPANY WEBSITE (${emailAnalysis.domain}):`);
    if (websiteData.title) contextParts.push(`  Site Title: ${websiteData.title}`);
    if (websiteData.description) contextParts.push(`  Description: ${websiteData.description}`);
    if (websiteData.raw) {
      contextParts.push(
        `  Page Content:\n${wrapDocumentContent(websiteData.raw.slice(0, 1000), `${emailAnalysis.domain}-website`)}`,
      );
    }
  }

  // CRM documents — each excerpt comes from user-uploaded extractedText;
  // wrap as untrusted external data (Task 4.7).
  if (docResults.length > 0) {
    contextParts.push(`\nFOUND IN ${docResults.length} CRM DOCUMENT(S):`);
    for (const doc of docResults.slice(0, 5)) {
      contextParts.push(
        `  Document: "${doc.name}"\n  Excerpt:\n${wrapDocumentContent(doc.excerpt.slice(0, 300), doc.name)}`,
      );
    }
  }

  // Linked deals
  if (dealResults.length > 0) {
    contextParts.push(`\nLINKED TO ${dealResults.length} DEAL(S):`);
    for (const deal of dealResults) {
      contextParts.push(`  - ${deal.name} (${deal.stage}, ${deal.industry})`);
    }
  }

  // Past interactions
  if (activityResults.length > 0) {
    contextParts.push(`\nPAST INTERACTIONS (${activityResults.length}):`);
    for (const act of activityResults.slice(0, 5)) {
      const date = new Date(act.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      contextParts.push(`  [${date}] ${act.type}: ${act.title}${act.description ? ` — ${act.description}` : ''}`);
    }
  }

  // Relationship proximity
  if (sameCompanyContacts.length > 0) {
    contextParts.push(`\nOTHER CONTACTS AT SAME COMPANY (${sameCompanyContacts.length}):`);
    for (const c of sameCompanyContacts.slice(0, 5)) {
      contextParts.push(`  - ${c.firstName} ${c.lastName}${c.title ? ` (${c.title})` : ''}`);
    }
  }

  // Existing notes
  if (noteResults?.notes) contextParts.push(`\nEXISTING NOTES: ${noteResults.notes}`);
  if (noteResults?.linkedinUrl) contextParts.push(`LINKEDIN: ${noteResults.linkedinUrl}`);

  // Calculate staleness + suggest (do NOT auto-write) a follow-up cadence.
  let staleWarning: string | null = null;
  const suggestedFollowUp = computeSuggestedFollowUp(noteResults?.lastContactedAt, fullName);
  if (noteResults?.lastContactedAt) {
    const daysSince = Math.floor((Date.now() - new Date(noteResults.lastContactedAt).getTime()) / 86400000);
    if (daysSince > 90) staleWarning = `WARNING: Last contacted ${daysSince} days ago — relationship going cold`;
    if (staleWarning) contextParts.push(`\n${staleWarning}`);
  }
  if (suggestedFollowUp?.action) {
    contextParts.push(`\nSUGGESTED FOLLOW-UP: ${suggestedFollowUp.action}`);
  }

  // LinkedIn search URL
  const linkedinSearchUrl = noteResults?.linkedinUrl || constructLinkedInUrl(state.firstName, state.lastName, state.company);

  // Sources
  const sources: string[] = [];
  if (emailAnalysis.domain && !emailAnalysis.isPersonal) sources.push('email_domain');
  if (websiteData) sources.push('company_website');
  if (docResults.length > 0) sources.push(`crm_docs(${docResults.length})`);
  if (dealResults.length > 0) sources.push(`deals(${dealResults.length})`);
  if (activityResults.length > 0) sources.push(`activities(${activityResults.length})`);
  if (sameCompanyContacts.length > 0) sources.push(`network(${sameCompanyContacts.length})`);

  steps.push({
    timestamp: new Date().toISOString(),
    node: 'gather',
    message: `Found: ${docResults.length} docs, ${dealResults.length} deals, ${activityResults.length} activities, ${sameCompanyContacts.length} same-co contacts, website=${!!websiteData}`,
  });

  return {
    crmContext: contextParts.join('\n') || 'No data found for this contact.',
    emailAnalysis: { ...emailAnalysis, linkedinSearchUrl, staleWarning, suggestedFollowUp },
    linkedDeals: dealResults,
    documentMentions: docResults.map((d: any) => d.name),
    sources,
    steps,
  };
}

// ─── Node 2: Research with LLM (using CRM context) ──────────────────

export async function researchNode(state: typeof EnrichmentState.State) {
  const steps = [...(state.steps || [])];
  steps.push({ timestamp: new Date().toISOString(), node: 'research', message: 'Synthesizing profile from CRM data' });

  const prompt = buildResearchPrompt({
    firstName: state.firstName,
    lastName: state.lastName,
    email: state.email,
    company: state.company,
    title: state.title,
    crmContext: state.crmContext,
    documentMentions: state.documentMentions,
    linkedDeals: state.linkedDeals,
  });

  try {
    const result = await invokeStructured(enrichmentSchema, [
      new SystemMessage('You are a CRM enrichment system. Only state facts supported by the provided data. Return valid JSON.'),
      new HumanMessage(prompt),
    ], { maxTokens: 2000, temperature: 0.3, label: 'contactEnrichment.research' });

    // Merge LLM results with gathered intelligence
    const enrichedData: Record<string, any> = {
      ...result,
      linkedinUrl: state.emailAnalysis?.linkedinSearchUrl || null,
      sources: state.sources,
      emailAnalysis: state.emailAnalysis,
      linkedDeals: state.linkedDeals,
      documentMentions: state.documentMentions,
      staleWarning: state.emailAnalysis?.staleWarning || null,
      suggestedFollowUp: state.emailAnalysis?.suggestedFollowUp || null,
    };

    // Use company from email domain if LLM didn't find one and user didn't provide one
    if (!result.company && !state.company && state.emailAnalysis?.companyFromDomain) {
      enrichedData.company = state.emailAnalysis.companyFromDomain;
    }

    steps.push({
      timestamp: new Date().toISOString(),
      node: 'research',
      message: `Profile synthesized. LLM confidence: ${result.confidence}%. Relevance: ${result.dealRelevance}`,
    });

    return {
      enrichedData,
      confidence: result.confidence,
      steps,
    };
  } catch (error: any) {
    log.error('Contact enrichment research failed', { error: error.message, contact: `${state.firstName} ${state.lastName}` });
    captureAgentError(error, { agent: 'contactEnrichment', node: 'research' }, 'warning');
    steps.push({ timestamp: new Date().toISOString(), node: 'research', message: `LLM synthesis failed: ${error.message}` });

    // Fallback: return what we gathered from CRM without LLM
    const hasDocs = state.documentMentions.length > 0;
    const hasDeals = state.linkedDeals.length > 0;
    const hasCorp = state.emailAnalysis?.isPersonal === false;
    let fallbackConfidence = 10;
    if (hasCorp) fallbackConfidence += 10;
    if (hasDocs) fallbackConfidence += 15;
    if (hasDeals) fallbackConfidence += 10;

    return {
      enrichedData: {
        title: state.title || null,
        company: state.company || state.emailAnalysis?.companyFromDomain || null,
        industry: null,
        location: null,
        bio: hasDocs ? `Mentioned in ${state.documentMentions.length} CRM document(s).` : null,
        expertise: [],
        dealRelevance: hasDeals ? 'medium' : 'low',
        confidence: fallbackConfidence,
        keyInsight: hasDocs
          ? `Found in: ${state.documentMentions.slice(0, 3).join(', ')}`
          : 'No CRM data found for this contact.',
        linkedinUrl: null,
        connections: null,
        sources: [...state.sources, 'error_fallback'],
        emailAnalysis: state.emailAnalysis,
        linkedDeals: state.linkedDeals,
        documentMentions: state.documentMentions,
        staleWarning: state.emailAnalysis?.staleWarning || null,
        suggestedFollowUp: state.emailAnalysis?.suggestedFollowUp || null,
      },
      confidence: fallbackConfidence,
      steps,
      error: error.message,
    };
  }
}

// ─── Node 3: Validate & Score ────────────────────────────────────────

export async function validateNode(state: typeof EnrichmentState.State) {
  const steps = [...(state.steps || [])];
  const data = state.enrichedData || {};

  let score = state.confidence;
  const factors: string[] = [];

  // Boost based on REAL data found (not just LLM inference)
  const hasCorporateEmail = state.emailAnalysis?.isPersonal === false;
  const docCount = state.documentMentions?.length || 0;
  const dealCount = state.linkedDeals?.length || 0;

  if (hasCorporateEmail) { score += 5; factors.push('corporate email'); }
  if (docCount > 0) { score += Math.min(docCount * 5, 15); factors.push(`found in ${docCount} docs`); }
  if (dealCount > 0) { score += Math.min(dealCount * 5, 10); factors.push(`${dealCount} linked deals`); }
  if (data.industry) { score += 3; factors.push('industry identified'); }

  // Cap based on data quality
  const hasRealData = docCount > 0 || dealCount > 0;
  const maxConfidence = hasRealData ? 85 : (hasCorporateEmail ? 60 : 40);
  score = Math.min(score, maxConfidence);

  // Minimum floor — never show 0% if we at least tried
  score = Math.max(score, 10);

  const needsReview = score < 70;
  factors.push(`max: ${maxConfidence}, real_data: ${hasRealData}`);

  steps.push({
    timestamp: new Date().toISOString(),
    node: 'validate',
    message: `Score: ${score}%, ${needsReview ? 'needs review' : 'auto-save'}. ${factors.join(', ')}`,
  });

  return { confidence: score, needsReview, steps };
}

// ─── Node 4: Save to Database ────────────────────────────────────────

export async function saveNode(state: typeof EnrichmentState.State) {
  const steps = [...(state.steps || [])];
  const data = state.enrichedData || {};

  try {
    const updateData: Record<string, any> = {};

    if (data.title && !state.title) updateData.title = data.title;
    if (data.company && !state.company) updateData.company = data.company;
    if (data.location) {
      const existing = await supabase.from('Contact').select('notes').eq('id', state.contactId).single();
      const currentNotes = existing.data?.notes || '';
      if (!currentNotes.includes('Location:')) {
        updateData.notes = `${currentNotes}\nLocation: ${data.location}`.trim();
      }
    }

    // Add enrichment tag
    if (data.dealRelevance) {
      const { data: contact } = await supabase.from('Contact').select('tags').eq('id', state.contactId).single();
      const tags = contact?.tags || [];
      const enrichTag = `enriched:${data.dealRelevance}`;
      if (!tags.includes(enrichTag)) {
        updateData.tags = [...tags.filter((t: string) => !t.startsWith('enriched:')), enrichTag];
      }
    }

    if (Object.keys(updateData).length > 0) {
      updateData.updatedAt = new Date().toISOString();
      await supabase.from('Contact').update(updateData).eq('id', state.contactId);
      steps.push({
        timestamp: new Date().toISOString(),
        node: 'save',
        message: `Updated ${Object.keys(updateData).length} fields: ${Object.keys(updateData).join(', ')}`,
      });
    } else {
      steps.push({ timestamp: new Date().toISOString(), node: 'save', message: 'No new data to save' });
    }

    return { status: 'completed', steps };
  } catch (error: any) {
    steps.push({ timestamp: new Date().toISOString(), node: 'save', message: `Save failed: ${error.message}` });
    captureAgentError(error, { agent: 'contactEnrichment', node: 'save' });
    return { status: 'failed', error: error.message, steps };
  }
}

// ─── Node 5: Flag for Review ─────────────────────────────────────────

export async function reviewNode(state: typeof EnrichmentState.State) {
  const steps = [...(state.steps || [])];
  steps.push({
    timestamp: new Date().toISOString(),
    node: 'review',
    message: `Flagged for review (confidence: ${state.confidence}%). Data preserved but not auto-saved.`,
  });
  return { status: 'needs_review', steps };
}

// ─── Conditional routing ────────────────────────────────────────────

export function routeAfterValidation(state: typeof EnrichmentState.State): string {
  if (state.error) return 'review';
  return state.needsReview ? 'review' : 'save';
}

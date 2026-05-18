// apps/api/src/services/agents/firmResearchAgent/nodes/synthesize.ts
import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { FirmResearchStateType, AgentStep, FirmProfile, PersonProfile } from '../state.js';
import { invokeStructured } from '../../../llm.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';
import { wrapDocumentContent } from '../../guardrails.js';

function step(message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node: 'synthesize', message, detail };
}

// Zod schemas for structured output
const FirmProfileSchema = z.object({
  description: z.string().default(''),
  strategy: z.string().default(''),
  sectors: z.array(z.string()).default([]),
  checkSizeRange: z.string().default(''),
  aum: z.string().default(''),
  teamSize: z.string().default(''),
  headquarters: z.string().default(''),
  foundedYear: z.string().default(''),
  investmentCriteria: z.string().default(''),
  keyDifferentiators: z.string().default(''),
  portfolioCompanies: z.array(z.object({
    name: z.string(),
    sector: z.string().default(''),
    status: z.string().default('active'),
  })).default([]),
  recentDeals: z.array(z.object({
    title: z.string(),
    date: z.string().default(''),
    source: z.string().default(''),
  })).default([]),
});

const PersonProfileSchema = z.object({
  title: z.string().default(''),
  role: z.string().default(''),
  bio: z.string().default(''),
  experience: z.array(z.string()).default([]),
  education: z.string().default(''),
  expertise: z.array(z.string()).default([]),
  yearsInPE: z.string().default(''),
  notableDeals: z.array(z.string()).default([]),
});

const FIRM_SYSTEM_PROMPT = `You are a private equity research analyst. Extract structured information about an investment firm from gathered research data.

ACCURACY RULES — FOLLOW STRICTLY:
1. ONLY extract facts that appear verbatim or near-verbatim in the source text.
   Do NOT infer, guess, or "fill in" fields based on what seems likely.
2. For every fact you extract, mentally identify the exact sentence in the
   source that supports it. If you cannot point to a specific sentence,
   leave the field empty.
3. Company name must EXACTLY match what appears on the website — do not
   correct spelling, expand abbreviations, or normalize capitalization.
4. For portfolio companies: only include names that appear in a clear
   "portfolio" or "investments" context. A company mentioned in a blog
   post is NOT a portfolio company.
5. If two sources contradict each other, include BOTH values with their
   sources rather than picking one.
6. Fund size / AUM: only include if stated as a specific number.
   "Significant capital" or "substantial resources" is NOT a fund size.
7. Sectors: only include sectors where the firm explicitly claims focus.
   Mentioning a sector in a news article is not the same as focusing on it.
8. Do NOT extract phone numbers, personal emails, home addresses, or SSNs.`;

const PERSON_SYSTEM_PROMPT = `You are a private equity research analyst. Extract structured information about a specific person from gathered research data.

ACCURACY RULES — FOLLOW STRICTLY:
1. ONLY include information where the person's name co-occurs with the fact
   in the SAME snippet/paragraph. Do not combine facts from different people.
2. If you cannot identify the specific person in the text, leave all fields empty.
3. Do NOT guess titles, roles, or experience based on the firm's seniority structure.
4. Education and experience must be explicitly stated, not inferred.
5. Do NOT extract phone numbers, personal emails, home addresses, or SSNs.`;

export async function synthesizeNode(
  state: FirmResearchStateType,
): Promise<Partial<FirmResearchStateType>> {
  const steps: AgentStep[] = [];

  const hasData = state.websiteText || state.firmSearchResults || state.personSearchResults;
  if (!hasData) {
    steps.push(step('No data gathered, skipping synthesis'));
    return { status: 'failed', error: 'Could not gather data — search may be temporarily unavailable. Please fill in manually and try "Refresh profile" later from Settings.', steps };
  }

  steps.push(step('Starting structured extraction (with Tier-2 fallback)'));

  // === Extract Firm Profile ===
  let firmProfile: FirmProfile | null = null;
  try {
    // Wrap each external-data block in <document> delimiters so the
    // model treats it as untrusted data, not instructions (Task 4.7).
    const firmContext = [
      state.websiteText
        ? `=== WEBSITE CONTENT ===\n${wrapDocumentContent(state.websiteText.slice(0, 12000), 'firm-website')}`
        : '',
      state.firmSearchResults
        ? `\n=== WEB SEARCH RESULTS ===\n${wrapDocumentContent(state.firmSearchResults, 'firm-web-search')}`
        : '',
    ].filter(Boolean).join('\n\n');

    const firmResult = await invokeStructured(FirmProfileSchema, [
      new SystemMessage(FIRM_SYSTEM_PROMPT),
      new HumanMessage(`Extract the firm profile for "${state.firmName}" from:\n\n${firmContext}`),
    ], { maxTokens: 2000, label: 'synthesize.firm' });

    firmProfile = {
      ...(firmResult as z.infer<typeof FirmProfileSchema>),
      confidence: 'medium',
      enrichedAt: new Date().toISOString(),
      sources: state.sources || [],
    } as FirmProfile;

    steps.push(step('Firm profile extracted', `${firmProfile.sectors.length} sectors, ${firmProfile.portfolioCompanies.length} portfolio cos`));
  } catch (error) {
    steps.push(step('Firm extraction failed', (error as Error).message));
    log.error('Firm synthesis failed', { error: (error as Error).message });
    captureAgentError(error, { agent: 'firmResearchAgent', node: 'synthesize.firm' }, 'warning');
  }

  // === Extract Person Profile ===
  let personProfile: PersonProfile | null = null;
  if (state.personSearchResults || state.linkedinUrl) {
    try {
      const personContext = [
        state.personSearchResults
          ? `=== PERSON SEARCH RESULTS ===\n${wrapDocumentContent(state.personSearchResults, 'person-web-search')}`
          : '',
        state.websiteText
          ? `\n=== FIRM WEBSITE (for context) ===\n${wrapDocumentContent(state.websiteText.slice(0, 4000), 'firm-website')}`
          : '',
      ].filter(Boolean).join('\n\n');

      const personResult = await invokeStructured(PersonProfileSchema, [
        new SystemMessage(PERSON_SYSTEM_PROMPT),
        new HumanMessage(`Extract the profile for the person at LinkedIn: ${state.linkedinUrl}\nFirm: ${state.firmName}\n\n${personContext}`),
      ], { maxTokens: 2000, label: 'synthesize.person' });

      personProfile = {
        ...(personResult as z.infer<typeof PersonProfileSchema>),
        linkedinUrl: state.linkedinUrl,
        verified: false,
      } as PersonProfile;

      steps.push(step('Person profile extracted', personProfile.title || 'no title found'));
    } catch (error) {
      steps.push(step('Person extraction failed', (error as Error).message));
      log.error('Person synthesis failed', { error: (error as Error).message });
      captureAgentError(error, { agent: 'firmResearchAgent', node: 'synthesize.person' }, 'warning');
    }
  }

  return {
    firmProfile,
    personProfile,
    status: firmProfile ? 'verifying' : 'failed',
    steps,
  };
}

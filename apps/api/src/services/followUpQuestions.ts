// ─── AI Follow-Up Questions Service ─────────────────────────────
// Generates 3-4 contextual follow-up questions based on extracted deal data.
// Uses getFastModel() (GPT-4o-mini) for speed and cost (~$0.003/call).

import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getFastModel, isLLMAvailable } from './llm.js';
import { log } from '../utils/logger.js';

// ─── Output Schema ──────────────────────────────────────────────

// `.nullable().optional()` (rather than bare `.optional()`) is required by
// OpenAI's strict structured-output mode — it rejects properties marked optional
// without nullable. The pairing means: field MUST appear in the JSON, but its
// value may be null. See https://platform.openai.com/docs/guides/structured-outputs
const FollowUpQuestionSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    type: z.enum(['choice', 'text']),
    question: z.string().describe('Short question, under 15 words'),
    reason: z.string().describe('Why this question is relevant, referencing extracted data'),
    options: z.array(z.string()).nullable().optional().describe('3-4 short options for choice questions'),
    placeholder: z.string().nullable().optional().describe('Placeholder text for text questions'),
  })).min(3).max(4),
});

export type FollowUpQuestion = z.infer<typeof FollowUpQuestionSchema>['questions'][number];

// ─── System Prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior private equity analyst helping investors evaluate deals. Based on the extracted deal data provided, generate exactly 4 short follow-up questions that would help the investor analyze this opportunity better.

RULES:
1. Generate exactly 3 "choice" questions and 1 "text" question
2. Each question MUST reference specific data from the extraction — cite actual numbers, risks, or highlights from the document
3. The "reason" field must explain WHY you're asking, referencing the document data (e.g., "Based on the 95% aggregator dependency" or "Given the ₹19Cr revenue from 6 outlets")
4. Choice questions: exactly 3-4 options each, kept under 4 words per option
5. Questions should be SHORT — under 15 words each
6. The text question should always be last (id: "q4")
7. Never ask about data already clearly extracted — don't re-ask revenue, EBITDA, company name, or industry
8. Focus questions on: investment intent, key risk assessment, strategic priorities, and open-ended thesis

QUESTION TOPICS (pick from these, adapt to the specific deal):
- Investment type (acquisition vs minority vs growth equity)
- Key risk the investor wants to explore
- Hold period / timeline expectations
- What specifically attracted them to this deal
- Operational priorities post-investment
- Concerns about specific data points (e.g., concentration, margins, growth)

Assign ids as "q1", "q2", "q3", "q4".`;

// ─── Main Function ──────────────────────────────────────────────

export interface ExtractionSummary {
  companyName?: string | null;
  industry?: string | null;
  revenue?: number | null;
  ebitda?: number | null;
  currency?: string;
  summary?: string;
  keyRisks?: string[];
  investmentHighlights?: string[];
  overallConfidence?: number;
}

export async function generateFollowUpQuestions(
  extraction: ExtractionSummary
): Promise<FollowUpQuestion[]> {
  if (!isLLMAvailable()) {
    log.warn('Follow-up questions skipped: no LLM provider configured');
    return getDefaultQuestions();
  }

  try {
    const model = getFastModel(0.7, 800, 'follow_up_questions');
    // method: 'functionCalling' avoids strict json_schema mode entirely — gives
    // the LLM more leeway with optional fields and skips OpenAI's draft-2020 nits.
    const structuredModel = model.withStructuredOutput(FollowUpQuestionSchema, {
      method: 'functionCalling',
      name: 'follow_up_questions',
    });

    const extractionContext = [
      extraction.companyName ? `Company: ${extraction.companyName}` : null,
      extraction.industry ? `Industry: ${extraction.industry}` : null,
      extraction.revenue != null ? `Revenue: ${extraction.revenue}M ${extraction.currency || 'USD'}` : null,
      extraction.ebitda != null ? `EBITDA: ${extraction.ebitda}M ${extraction.currency || 'USD'}` : null,
      extraction.summary ? `Summary: ${extraction.summary}` : null,
      extraction.keyRisks?.length ? `Key Risks: ${extraction.keyRisks.join('; ')}` : null,
      extraction.investmentHighlights?.length ? `Highlights: ${extraction.investmentHighlights.join('; ')}` : null,
      extraction.overallConfidence != null ? `Extraction Confidence: ${extraction.overallConfidence}%` : null,
    ].filter(Boolean).join('\n');

    const result = await structuredModel.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(`Generate follow-up questions for this deal:\n\n${extractionContext}`),
    ]);

    log.info('Follow-up questions generated', { count: result.questions.length, company: extraction.companyName });
    return result.questions;
  } catch (err: any) {
    log.error('Follow-up question generation failed', err);
    return getDefaultQuestions();
  }
}

// ─── Default Fallback ───────────────────────────────────────────

function getDefaultQuestions(): FollowUpQuestion[] {
  return [
    {
      id: 'q1',
      type: 'choice',
      question: 'What type of investment are you considering?',
      reason: 'Helps frame the financial analysis',
      options: ['Majority Acquisition', 'Minority Stake', 'Growth Equity', 'Exploring'],
    },
    {
      id: 'q2',
      type: 'choice',
      question: 'What\'s your expected hold period?',
      reason: 'Helps with exit modeling and return projections',
      options: ['1-2 years', '3-5 years', '5-7 years', 'Open-ended'],
    },
    {
      id: 'q3',
      type: 'choice',
      question: 'How would you rate the urgency of this deal?',
      reason: 'Helps prioritize your deal pipeline',
      options: ['High — act fast', 'Medium', 'Low — exploratory'],
    },
    {
      id: 'q4',
      type: 'text',
      question: 'What caught your attention about this deal?',
      reason: 'Helps AI tailor future analysis to your thesis',
      placeholder: 'e.g., Strong margins, market position, expansion potential...',
    },
  ];
}

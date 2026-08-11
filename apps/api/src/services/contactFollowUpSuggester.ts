// ─── Contact Follow-up Suggester (lightweight, single LLM call) ──────
// Purpose: surface a recommended follow-up date + action for a contact
// WITHOUT running the full contact-enrichment LangGraph agent (web scrape +
// multi-node research). The model reasons over the contact's recent
// interaction history and decides an appropriate cadence + next action.
//
// Contract: ONE bounded LLM call. Falls back to a deterministic recency
// heuristic if the LLM is unavailable or fails. NEVER writes followUpAt —
// it only SUGGESTS (the caller/UI applies it).

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getChatModel } from './llm.js';
import { log } from '../utils/logger.js';

export interface FollowUpSuggestion {
  date: string;      // ISO 8601 date of the suggested follow-up
  action: string;    // one-line recommended next action
  reasoning: string; // why this date/action (from the model or the fallback)
}

export interface RecentInteraction {
  type: string;             // NOTE | MEETING | CALL | EMAIL | OTHER
  title?: string | null;
  date?: string | null;     // ISO
}

export interface FollowUpSuggesterInput {
  fullName: string;
  type?: string | null;             // contact relationship type (e.g. FOUNDER)
  company?: string | null;
  title?: string | null;            // job title
  lastContactedAt?: string | null;  // ISO
  interactions: RecentInteraction[];
}

// LLM is asked to return exactly this shape.
const suggestionSchema = z.object({
  daysFromNow: z
    .number()
    .int()
    .min(0)
    .max(365)
    .describe('How many days from today the follow-up should happen.'),
  action: z.string().describe('One concise sentence: the recommended next action.'),
  reasoning: z
    .string()
    .describe('One short sentence explaining why this cadence, citing the history.'),
});

// ─── Deterministic fallback (recency heuristic) ─────────────────────
// Mirrors the cadence used elsewhere in the app: never-contacted → 3 days;
// cold (>90d) → tomorrow; warming (>30d) → 7 days; recent → 30 days.
export function fallbackFollowUp(
  lastContactedAt: string | null | undefined,
  fullName: string,
): FollowUpSuggestion {
  const now = Date.now();
  const addDays = (d: number) => new Date(now + d * 86400000).toISOString();
  const name = (fullName || '').trim() || 'this contact';

  if (!lastContactedAt) {
    return {
      date: addDays(3),
      action: `Reach out to ${name} to open the relationship.`,
      reasoning: 'No interactions logged yet, so a near-term first touch is recommended.',
    };
  }

  const parsed = new Date(lastContactedAt).getTime();
  if (Number.isNaN(parsed)) {
    return {
      date: addDays(7),
      action: `Schedule a check-in with ${name}.`,
      reasoning: 'Last-contact date could not be read; defaulting to a one-week check-in.',
    };
  }

  const daysSince = Math.floor((now - parsed) / 86400000);
  if (daysSince > 90) {
    return {
      date: addDays(1),
      action: `Send a re-engagement note to ${name} before the relationship goes cold.`,
      reasoning: `Last contact was ${daysSince} days ago — overdue, so follow up immediately.`,
    };
  }
  if (daysSince > 30) {
    return {
      date: addDays(7),
      action: `Schedule a check-in with ${name} within the week.`,
      reasoning: `It has been ${daysSince} days since last contact — time for a check-in.`,
    };
  }
  return {
    date: addDays(30),
    action: `Plan a routine follow-up with ${name} in about a month.`,
    reasoning: `Recently engaged (${daysSince} days ago) — a routine cadence is sufficient.`,
  };
}

// Convert a model "daysFromNow" into an ISO date string.
function isoFromDaysOut(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// ─── Public: suggest a follow-up via a single bounded LLM call ──────
export async function suggestContactFollowUp(
  input: FollowUpSuggesterInput,
): Promise<FollowUpSuggestion> {
  const name = (input.fullName || '').trim() || 'this contact';
  const today = new Date().toISOString().split('T')[0];

  // Keep the prompt small: only the most recent interactions, capped.
  const recent = (input.interactions || [])
    .filter((i) => i && (i.date || i.title || i.type))
    .slice(0, 12)
    .map((i) => {
      const d = i.date ? new Date(i.date) : null;
      const dateStr = d && !Number.isNaN(d.getTime()) ? d.toISOString().split('T')[0] : 'unknown date';
      return `- [${dateStr}] ${i.type || 'OTHER'}${i.title ? `: ${i.title}` : ''}`;
    })
    .join('\n');

  const lastContacted = input.lastContactedAt
    ? (() => {
        const d = new Date(input.lastContactedAt as string);
        return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().split('T')[0];
      })()
    : 'never';

  const profileLines = [
    `Name: ${name}`,
    input.type ? `Relationship: ${input.type}` : null,
    input.title ? `Title: ${input.title}` : null,
    input.company ? `Company: ${input.company}` : null,
    `Last contacted: ${lastContacted}`,
  ].filter(Boolean);

  const prompt = [
    `Today's date is ${today}.`,
    '',
    'You are a relationship-management assistant for a private-equity dealmaker.',
    'Decide WHEN this contact should next be followed up with, and the single',
    'most useful next action. Base the cadence on the ACTUAL interaction history',
    'below — frequency, recency, and the nature of recent touches. A contact who',
    'was just met warrants a sooner, warmer follow-up than one in routine',
    'maintenance; a long-silent relationship needs prompt re-engagement.',
    '',
    'CONTACT:',
    profileLines.join('\n'),
    '',
    'RECENT INTERACTIONS (most recent first):',
    recent || '(none logged)',
    '',
    'Return daysFromNow (an integer number of days from today), a one-sentence',
    'action, and one-sentence reasoning.',
  ].join('\n');

  try {
    const model = getChatModel(0.3, 220, 'contactFollowUpSuggester');
    const structured = await model
      .withStructuredOutput(suggestionSchema, {
        method: 'functionCalling',
        name: 'suggest_follow_up',
      })
      .invoke(
        [
          new SystemMessage(
            'You suggest contact follow-up timing. Be decisive and concise. Return valid structured output only.',
          ),
          new HumanMessage(prompt),
        ],
        { runName: 'contactFollowUpSuggester', tags: ['follow-up'] },
      );

    const result = suggestionSchema.parse(structured);
    return {
      date: isoFromDaysOut(result.daysFromNow),
      action: result.action.trim(),
      reasoning: result.reasoning.trim(),
    };
  } catch (error: any) {
    log.warn('contactFollowUpSuggester: LLM failed, using deterministic fallback', {
      contact: name,
      error: error?.message,
    });
    return fallbackFollowUp(input.lastContactedAt, name);
  }
}

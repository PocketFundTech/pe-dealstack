// ─── Deep research — Phase 2 query generation ────────────────────
// Calls the LLM to produce 8-12 targeted follow-up search queries
// based on the Phase 1 firm + person profiles.

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { FirmProfile, PersonProfile } from './state.js';
import { invokeStructured } from '../../llm.js';
import { log } from '../../../utils/logger.js';

export interface GeneratedQuery {
  query: string;
  category: string;
  reason: string;
}

export const MAX_PRIMARY_QUERIES = 12;

// Anthropic/OpenAI tool input schemas must have a top-level type of "object",
// so the array of queries is wrapped in an object rather than passed as a bare
// z.array (which serialises to type "array" and is rejected with a 400).
const QuerySchema = z.object({
  queries: z.array(z.object({
    query: z.string(),
    category: z.enum(['person', 'deals', 'portfolio', 'reputation', 'social', 'network']),
    reason: z.string(),
  })),
});

export async function generateQueries(
  firmProfile: FirmProfile | null,
  personProfile: PersonProfile | null,
): Promise<GeneratedQuery[]> {
  const systemPrompt = `You are a PE research analyst. Based on an initial scan of a firm, generate 8-12 targeted DuckDuckGo search queries to find DEEPER information.

Focus on:
1. The person's public presence (interviews, podcasts, talks, social media)
2. Specific deal history (acquisitions, exits, deal sizes)
3. Each portfolio company (what they do, when acquired)
4. Firm reputation (press articles, reviews, rankings)
5. Social presence (Twitter, YouTube, newsletters, blogs)
6. Network (co-investors, community involvement, LPs)

Rules:
- Use exact names and handles found in the initial scan (don't guess)
- Combine terms for specificity: "name" + "firm" + "topic"
- Use site: operator for specific platforms (site:twitter.com, site:crunchbase.com)
- Generate diverse queries across all 6 categories
- Don't repeat generic queries like "firm name private equity"`;

  const userPrompt = `Initial scan results:

FIRM PROFILE:
${JSON.stringify(firmProfile, null, 2)}

PERSON PROFILE:
${JSON.stringify(personProfile, null, 2)}

Generate 8-12 targeted follow-up search queries.`;

  try {
    const result = await invokeStructured(QuerySchema, [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ], { maxTokens: 1500, temperature: 0.3, label: 'deepResearch.queries' });
    return (result.queries as GeneratedQuery[]).slice(0, MAX_PRIMARY_QUERIES);
  } catch (error) {
    log.error('Deep research: query generation failed', { error: (error as Error).message });
    return [];
  }
}

// ─── Follow-the-Thread: Extract New Names ─────────────────────────

export function extractNewNames(
  snippets: string,
  knownNames: Set<string>,
): string[] {
  // Find capitalized multi-word phrases (likely company/person names)
  const matches = snippets.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];

  // Count occurrences
  const counts = new Map<string, number>();
  for (const name of matches) {
    const lower = name.toLowerCase();
    if (knownNames.has(lower)) continue;
    if (name.length < 5 || name.length > 50) continue;
    // Skip common phrases
    if (['United States', 'New York', 'San Francisco', 'Private Equity', 'Managing Director',
         'Vice President', 'Chief Executive', 'Read More', 'Learn More', 'Terms Service',
         'Privacy Policy', 'All Rights'].some(skip => name.includes(skip))) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  // Return names that appear 2+ times (likely significant)
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
}

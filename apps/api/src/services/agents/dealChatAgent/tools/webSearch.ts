// ─── web_search tool ──────────────────────────────────────────────
// Generic Tavily-backed web search. Used by the deal chat agent for
// current news, competitive intel, and market signals — anything that
// isn't already in the deal's documents/financials.
//
// Factory is NOT closure-bound to a deal/org (search is generic). A
// per-instance call counter enforces a soft cap of 3 searches per
// tool-instance lifetime. Since getDealChatTools() is invoked once per
// chat turn, this naturally yields per-turn limiting.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { log } from '../../../../utils/logger.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const MAX_SEARCHES_PER_TURN = 3;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
}

interface TavilyResponse {
  query?: string;
  results?: TavilyResult[];
  answer?: string | null;
}

interface TavilyRequestBody {
  api_key: string;
  query: string;
  max_results: number;
  include_answer: boolean;
  search_depth: 'basic' | 'advanced';
  topic?: 'general' | 'news';
  days?: number;
}

type TavilyAttempt =
  | { ok: true; payload: TavilyResponse }
  | { ok: false; rateLimited: boolean; reason: string };

async function tavilyOnce(apiKey: string, body: Omit<TavilyRequestBody, 'api_key'>): Promise<TavilyAttempt> {
  const fullBody: TavilyRequestBody = { api_key: apiKey, ...body };
  let response: Response;
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullBody),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    return { ok: false, rateLimited: false, reason };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      // ignore — fall back to status only
    }
    const reason = detail ? `HTTP ${response.status} (${detail})` : `HTTP ${response.status}`;
    // 429 is the classic rate-limit code; 432 has been observed from Tavily as
    // a quota/credits-exhausted code. Treat both as a signal to roll the key.
    const rateLimited = response.status === 429 || response.status === 432;
    return { ok: false, rateLimited, reason };
  }

  try {
    const payload = (await response.json()) as TavilyResponse;
    return { ok: true, payload };
  } catch {
    return { ok: false, rateLimited: false, reason: 'invalid response from search provider' };
  }
}

export function makeWebSearchTool() {
  let callCount = 0;
  // Remember which key is exhausted for the lifetime of this tool instance
  // (one chat turn). Avoids the latency of bouncing off primary 432 → roll
  // to fallback on every subsequent call in the same turn. Tavily docs say
  // errors don't consume credits, but the extra round-trip still costs the
  // user wall-clock time and adds noise to the logs.
  let primaryExhausted = false;

  return tool(
    async ({ query, max_results, recency_days, topic, search_depth }) => {
      const effectiveMaxResults = max_results ?? 5;
      // News-index when caller asks (or specifies recency); general otherwise.
      const effectiveTopic: 'general' | 'news' =
        topic ?? (typeof recency_days === 'number' ? 'news' : 'general');
      // Default to BASIC depth (1 credit per Tavily). Advanced doubles the
      // cost to 2 credits per call and only marginally improves recall on
      // niche brands — empirically it didn't move the needle on the user's
      // Website Speedy run. Callers can opt-in via search_depth: "advanced"
      // when they're doing a deep dive on a known-active target.
      const effectiveDepth: 'basic' | 'advanced' = search_depth ?? 'basic';

      log.info('[web_search] called', {
        query,
        max_results: effectiveMaxResults,
        recency_days,
        topic: effectiveTopic,
        depth: effectiveDepth,
      });

      const primaryKey = process.env.TAVILY_API_KEY;
      const fallbackKey = process.env.TAVILY_API_KEY_FALLBACK;
      if (!primaryKey) {
        return 'Web search is not configured — ask an admin to set TAVILY_API_KEY.';
      }

      callCount += 1;
      if (callCount > MAX_SEARCHES_PER_TURN) {
        return `Search limit (${MAX_SEARCHES_PER_TURN} per turn) reached. Refine queries and try again next turn.`;
      }

      const requestBody: Omit<TavilyRequestBody, 'api_key'> = {
        query,
        max_results: effectiveMaxResults,
        include_answer: false,
        search_depth: effectiveDepth,
        topic: effectiveTopic,
      };
      if (typeof recency_days === 'number') {
        requestBody.days = recency_days;
      }

      // If primary already exhausted in this turn, skip straight to fallback.
      let keyTier: 'primary' | 'fallback' = primaryExhausted && fallbackKey ? 'fallback' : 'primary';
      let attempt = await tavilyOnce(keyTier === 'fallback' ? fallbackKey! : primaryKey, requestBody);

      if (!attempt.ok && attempt.rateLimited && keyTier === 'primary' && fallbackKey) {
        log.warn('[web_search] primary key rate-limited/credits-exhausted, rolling to fallback for the rest of this turn', { query });
        primaryExhausted = true;
        attempt = await tavilyOnce(fallbackKey, requestBody);
        keyTier = 'fallback';
      }

      if (!attempt.ok) {
        log.error('web_search tool failed', undefined, { reason: attempt.reason, query, keyTier });
        return `Search failed: ${attempt.reason}`;
      }

      const payload = attempt.payload;

      const results = Array.isArray(payload.results) ? payload.results : [];
      if (results.length === 0) {
        return `Found 0 results for "${query}".`;
      }

      const lines: string[] = [`Found ${results.length} results for "${query}":`, ''];
      results.forEach((r, idx) => {
        const title = r.title?.trim() || 'Untitled';
        const date = r.published_date?.trim() || 'date unknown';
        const url = r.url?.trim() || '';
        const snippet = (r.content || '').trim().replace(/\s+/g, ' ');
        lines.push(`${idx + 1}. **${title}** — ${date}`);
        if (url) lines.push(`   ${url}`);
        if (snippet) lines.push(`   ${snippet}`);
        lines.push('');
      });

      return lines.join('\n').trimEnd();
    },
    {
      name: 'web_search',
      description:
        "Search the public web via Tavily. Use for current news, competitive intel, market signals, and information not in the deal's documents. ALWAYS cite source URLs in your final answer. Treat web results as supplementary — never use them as a primary source for financial numbers.",
      schema: z.object({
        query: z
          .string()
          .describe('Search query. Include the company name or industry for grounding.'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .optional()
          .describe('Number of results, default 5'),
        recency_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Limit to results from the last N days'),
        topic: z
          .enum(['general', 'news'])
          .optional()
          .describe(
            "Search index to use. 'news' is filtered to news articles (better for recent company news, funding, acquisitions, personnel moves). 'general' (default) covers the open web. If recency_days is set without topic, topic defaults to 'news'.",
          ),
        search_depth: z
          .enum(['basic', 'advanced'])
          .optional()
          .describe(
            "Search depth. 'basic' (default, 1 credit/call) is sufficient for ~95% of queries. 'advanced' (2 credits/call) yields slightly more thorough snippets — use ONLY for a deep dive on a known-active target where basic returned thin results.",
          ),
      }),
    },
  );
}

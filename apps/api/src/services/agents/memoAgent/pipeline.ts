// ─── Memo Agent — Parallel Section Generation Pipeline ───────────────────────
// Orchestrates parallel LLM calls to generate all IC memo sections at once.

import { buildMemoContext, formatContextForLLM, MemoContext } from './context.js';
import {
  MEMO_SYSTEM_PROMPT,
  SECTION_PROMPTS,
  SectionType,
  COMPREHENSIVE_IC_SECTIONS,
} from './prompts.js';
import { trackedClaudeMessage, isAnthropicAvailable } from '../../ai/client.js';
import { log } from '../../../utils/logger.js';
import { captureAgentError } from '../../../utils/sentryHelpers.js';
import { resolveTimeoutMs } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// Each section is a single LLM call (not a multi-step agent). Cap each
// at 30s via AbortSignal so a stuck OpenAI request can't pin a worker
// past Vercel's function limit while billing continues.
const SECTION_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeneratedSection {
  type: string;
  title: string;
  content: string;
  tableData?: any;
  chartConfig?: any;
  aiGenerated: boolean;
  aiModel: string;
  sortOrder?: number;
}

// ─── Rate-limit helpers ──────────────────────────────────────────────────────

const BATCH_SIZE = 3; // Max concurrent LLM calls to avoid 429s
const BATCH_DELAY_MS = 2000; // Pause between batches
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000; // Wait before retrying a 429

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post-process AI output to ensure proper HTML structure.
 * Catches cases where GPT returns a wall of text without tags.
 */
function ensureHtmlFormatting(html: string): string {
  if (!html || html.trim().length === 0) return html;

  // If content already has <h3> or <p> tags, it's likely well-formatted
  if (/<h3[\s>]/i.test(html) && /<p[\s>]/i.test(html)) return html;

  // If content has no HTML block tags at all, wrap paragraphs
  if (!/<(?:p|h[1-6]|ul|ol|li|div|table|section)[\s>]/i.test(html)) {
    // Split on double newlines or bold markers that look like sub-headings
    const lines = html.split(/\n{2,}/);
    return lines
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        // Detect bold sub-heading patterns like "**Valuation**:" or "Valuation:"
        const headingMatch = trimmed.match(/^\*\*(.+?)\*\*[:\s]/);
        if (headingMatch) {
          const heading = headingMatch[1];
          const rest = trimmed.slice(headingMatch[0].length).trim();
          return `<h3>${heading}</h3>\n<p>${rest}</p>`;
        }
        return `<p>${trimmed}</p>`;
      })
      .filter(Boolean)
      .join('\n');
  }

  // If it has some tags but no <p> wrapping, wrap loose text nodes
  if (!/<p[\s>]/i.test(html)) {
    return html.replace(/(?:^|\n)([^<\n][^\n]*)/g, '\n<p>$1</p>');
  }

  return html;
}

// ─── Placeholder helpers ──────────────────────────────────────────────────────

const FINANCIAL_PLACEHOLDER =
  '<p><em>[Financial data not yet available. Upload financial documents to auto-generate this section.]</em></p>';

function makePlaceholder(
  sectionType: string,
  title: string,
  content: string,
  aiModel: string,
  sortOrder?: number,
): GeneratedSection {
  return {
    type: sectionType,
    title,
    content,
    aiGenerated: false,
    aiModel,
    ...(sortOrder !== undefined ? { sortOrder } : {}),
  };
}

// ─── generateSection ──────────────────────────────────────────────────────────

export async function generateSection(
  sectionType: SectionType,
  context: MemoContext,
  customPrompt?: string,
  sortOrder?: number,
  retryCount?: number,
): Promise<GeneratedSection> {
  const promptConfig = SECTION_PROMPTS[sectionType];

  if (!promptConfig) {
    return makePlaceholder(
      sectionType,
      sectionType,
      `<p><em>[Unknown section type: ${sectionType}]</em></p>`,
      'error',
      sortOrder,
    );
  }

  const { title, requiresFinancials, includeTableData, includeChartConfig } = promptConfig;

  // If section requires financials but none are available, return placeholder
  if (requiresFinancials && (!context.financials || context.financials.length === 0)) {
    return {
      ...makePlaceholder(sectionType, title, FINANCIAL_PLACEHOLDER, 'placeholder', sortOrder),
    };
  }

  try {
    const sectionPrompt = customPrompt ?? promptConfig.prompt;
    const contextText = formatContextForLLM(context);

    const formatInstruction =
      includeTableData || includeChartConfig
        ? '\n\nReturn your response as valid JSON matching the structure described in the prompt above.'
        : '\n\nReturn your response as clean HTML only (no markdown, no code fences).';

    const userPrompt = `${sectionPrompt}\n\n---\n\n## Deal Context\n\n${contextText}${formatInstruction}`;

    // Bound the LLM call — AbortSignal is now forwarded all the way to the
    // in-flight Anthropic request (Task 1), not just raced client-side.
    const timeoutMs = resolveTimeoutMs(SECTION_TIMEOUT_MS, 'MEMO_SECTION_TIMEOUT_MS');
    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Memo section ${sectionType} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let result: { text: string; model: string };
    try {
      result = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_section_generation',
          role: 'memo',
          system: MEMO_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 2000,
          signal: abortController.signal,
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const rawText = result.text;

    let content = rawText;
    let tableData: any = undefined;
    let chartConfig: any = undefined;

    if (includeTableData || includeChartConfig) {
      // Strip markdown code fences if present
      const stripped = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      try {
        const parsed = JSON.parse(stripped);
        content = parsed.content ?? rawText;
        if (parsed.tableData !== undefined) tableData = parsed.tableData;
        if (parsed.chartConfig !== undefined) chartConfig = parsed.chartConfig;
      } catch (err) {
        // JSON parse failed — use raw text as content
        log.warn(`[memoAgent/pipeline] JSON parse failed for section ${sectionType}, using raw text`, { error: err instanceof Error ? err.message : String(err) });
        content = rawText;
      }
    }

    return {
      type: sectionType,
      title,
      content: ensureHtmlFormatting(content),
      ...(tableData !== undefined ? { tableData } : {}),
      ...(chartConfig !== undefined ? { chartConfig } : {}),
      aiGenerated: true,
      aiModel: result.model,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    };
  } catch (err: any) {
    // Retry on 429 rate limit errors
    const is429 = err?.message?.includes('429') || err?.message?.includes('Rate limit');
    if (is429 && (retryCount ?? 0) < MAX_RETRIES) {
      const attempt = (retryCount ?? 0) + 1;
      log.warn(`[memoAgent/pipeline] Rate limited on ${sectionType}, retrying (${attempt}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS * attempt);
      return generateSection(sectionType, context, customPrompt, sortOrder, attempt);
    }
    log.error(`[memoAgent/pipeline] Error generating section ${sectionType}: ${err?.message}`);
    captureAgentError(err, { agent: 'memoAgent', node: `pipeline.${sectionType}` }, 'warning');
    return makePlaceholder(
      sectionType,
      title,
      `<p><em>[Section generation failed: ${err?.message ?? 'Unknown error'}]</em></p>`,
      'error',
      sortOrder,
    );
  }
}

// ─── generateAllSections ──────────────────────────────────────────────────────

export async function generateAllSections(
  dealId: string,
  orgId: string,
  sectionTypes?: SectionType[],
): Promise<{ sections: GeneratedSection[]; context: MemoContext }> {
  if (!isAnthropicAvailable()) {
    throw new Error('LLM is not available. Check API key configuration.');
  }

  const types = sectionTypes ?? COMPREHENSIVE_IC_SECTIONS;

  log.info(`[memoAgent/pipeline] Building memo context for deal ${dealId}`);
  const context = await buildMemoContext(dealId, orgId);

  log.info(`[memoAgent/pipeline] Generating ${types.length} sections in batches of ${BATCH_SIZE}`);

  const sections: GeneratedSection[] = [];

  // Process in batches to avoid 429 rate limits
  for (let i = 0; i < types.length; i += BATCH_SIZE) {
    const batch = types.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((sectionType, batchIndex) =>
        generateSection(sectionType, context, undefined, i + batchIndex + 1),
      ),
    );
    sections.push(...batchResults);

    // Pause between batches (skip after the last batch)
    if (i + BATCH_SIZE < types.length) {
      log.debug(`[memoAgent/pipeline] Batch ${Math.floor(i / BATCH_SIZE) + 1} complete, pausing ${BATCH_DELAY_MS}ms`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  const generated = sections.filter((s) => s.aiGenerated).length;
  const failed = sections.filter((s) => s.aiModel === 'error').length;

  log.info(
    `[memoAgent/pipeline] Completed: ${sections.length} total, ${generated} generated, ${failed} failed`,
  );

  const graded = await critiqueAndRevise(sections, context);

  return { sections: graded, context };
}

// ─── Critique + Revise (Phase 2-C) ─────────────────────────────────────────
// One critique pass over the assembled memo, one targeted revise pass if it
// flags anything. Best-effort — any failure returns the original sections
// unchanged; a memo is never blocked by a grading failure (same non-blocking
// precedent as financialAgent/nodes/verifyNode.ts).

const CRITIQUE_TIMEOUT_MS = 30_000;
const REVISE_TIMEOUT_MS = 30_000;

const CRITIQUE_SYSTEM_PROMPT = `You are grading an Investment Committee memo against a fixed rubric before it reaches an analyst. Score honestly — a 3/5 pass bar is deliberately lenient; only fail a dimension for a real, specific problem.

Score each dimension 1-5 and mark it "pass" at 3 or above:
- thesis_clarity: does the memo state a clear, consistent investment thesis and recommendation, and do the sections support it rather than contradict it?
- financial_grounding: do cited numbers match across sections and against the verified deal data provided below? Are they plausible, not fabricated?
- risk_coverage: are the risks raised substantive and specific to this deal, not generic boilerplate?
- actionability: is the recommendation clear enough for an IC to act on (BUY/PASS/CONDITIONAL plus rationale), not vague hedging?

For any dimension that fails, name the specific section type(s) that need revision in sectionsNeedingRevision, using the exact section type strings shown in the memo (e.g. "EXECUTIVE_SUMMARY"). If every dimension passes, sectionsNeedingRevision must be empty and overallPass must be true.`;

const REVISE_SYSTEM_PROMPT = `You are revising specific sections of an Investment Committee memo to fix problems a grading pass identified. Keep the same HTML formatting conventions as the rest of the memo (h3 sub-headings, p tags, strong for key metrics). Only return the sections listed as needing revision, using their exact section type string — do not invent new sections or touch ones that weren't flagged. Fix the specific issue described for each section; don't rewrite unrelated content.`;

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    overallPass: { type: 'boolean' },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['thesis_clarity', 'financial_grounding', 'risk_coverage', 'actionability'] },
          score: { type: 'integer', minimum: 1, maximum: 5 },
          pass: { type: 'boolean' },
          issue: { type: 'string' },
        },
        required: ['name', 'score', 'pass'],
      },
    },
    sectionsNeedingRevision: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['overallPass', 'dimensions', 'sectionsNeedingRevision'],
};

const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    revisedSections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['type', 'content'],
      },
    },
  },
  required: ['revisedSections'],
};

interface CritiqueVerdict {
  overallPass: boolean;
  dimensions: Array<{ name: string; score: number; pass: boolean; issue?: string }>;
  sectionsNeedingRevision: string[];
}

interface ReviseResult {
  revisedSections: Array<{ type: string; content: string }>;
}

/**
 * Grade the assembled memo against a fixed rubric; revise only the flagged
 * sections if it fails. Best-effort — see module comment above.
 */
export async function critiqueAndRevise(
  sections: GeneratedSection[],
  context: MemoContext,
): Promise<GeneratedSection[]> {
  try {
    const memoText = sections
      .map((s) => `### Section: ${s.type} (${s.title})\n${s.content}`)
      .join('\n\n');
    const contextText = formatContextForLLM(context);

    const critiqueTimeoutMs = resolveTimeoutMs(CRITIQUE_TIMEOUT_MS, 'MEMO_CRITIQUE_TIMEOUT_MS');
    const critiqueController = new AbortController();
    let critiqueTimeoutHandle: NodeJS.Timeout | undefined;
    const critiqueTimeoutPromise = new Promise<never>((_, reject) => {
      critiqueTimeoutHandle = setTimeout(() => {
        critiqueController.abort();
        reject(new Error(`Memo critique timed out after ${critiqueTimeoutMs}ms`));
      }, critiqueTimeoutMs);
    });

    let critiqueResult: { text: string };
    try {
      critiqueResult = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_critique',
          role: 'memo',
          system: CRITIQUE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `## Verified Deal Data\n\n${contextText}\n\n## Memo Sections\n\n${memoText}`,
          }],
          outputSchema: CRITIQUE_SCHEMA,
          maxTokens: 2000,
          signal: critiqueController.signal,
        }),
        critiqueTimeoutPromise,
      ]);
    } finally {
      if (critiqueTimeoutHandle) clearTimeout(critiqueTimeoutHandle);
    }

    const verdict: CritiqueVerdict = JSON.parse(critiqueResult.text);

    if (verdict.overallPass || verdict.sectionsNeedingRevision.length === 0) {
      log.info('[memoAgent/pipeline] Memo passed critique', {
        dimensions: verdict.dimensions.map((d) => `${d.name}:${d.score}`),
      });
      return sections;
    }

    log.warn('[memoAgent/pipeline] Memo failed critique, revising flagged sections', {
      sectionsNeedingRevision: verdict.sectionsNeedingRevision,
      failedDimensions: verdict.dimensions.filter((d) => !d.pass).map((d) => `${d.name}:${d.issue}`),
    });

    const flaggedSections = sections.filter((s) => verdict.sectionsNeedingRevision.includes(s.type));
    if (flaggedSections.length === 0) return sections;

    const issuesText = verdict.dimensions
      .filter((d) => !d.pass)
      .map((d) => `- ${d.name}: ${d.issue ?? 'below rubric bar'}`)
      .join('\n');
    const flaggedText = flaggedSections
      .map((s) => `### Section: ${s.type} (${s.title})\n${s.content}`)
      .join('\n\n');

    const reviseTimeoutMs = resolveTimeoutMs(REVISE_TIMEOUT_MS, 'MEMO_REVISE_TIMEOUT_MS');
    const reviseController = new AbortController();
    let reviseTimeoutHandle: NodeJS.Timeout | undefined;
    const reviseTimeoutPromise = new Promise<never>((_, reject) => {
      reviseTimeoutHandle = setTimeout(() => {
        reviseController.abort();
        reject(new Error(`Memo revise timed out after ${reviseTimeoutMs}ms`));
      }, reviseTimeoutMs);
    });

    let reviseResult: { text: string; model: string };
    try {
      reviseResult = await Promise.race([
        trackedClaudeMessage({
          operation: 'memo_revise',
          role: 'memo',
          system: REVISE_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `## Issues Found\n\n${issuesText}\n\n## Sections Needing Revision\n\n${flaggedText}`,
          }],
          outputSchema: REVISE_SCHEMA,
          maxTokens: 6000,
          signal: reviseController.signal,
        }),
        reviseTimeoutPromise,
      ]);
    } finally {
      if (reviseTimeoutHandle) clearTimeout(reviseTimeoutHandle);
    }

    const revised: ReviseResult = JSON.parse(reviseResult.text);
    const revisedByType = new Map(revised.revisedSections.map((r) => [r.type, r.content]));

    return sections.map((s) => {
      const newContent = revisedByType.get(s.type);
      if (newContent === undefined) return s; // not flagged, or a hallucinated type — leave untouched
      return { ...s, content: ensureHtmlFormatting(newContent), aiModel: reviseResult.model };
    });
  } catch (err: any) {
    log.warn(`[memoAgent/pipeline] Critique/revise failed, returning ungraded memo: ${err?.message}`);
    captureAgentError(err, { agent: 'memoAgent', node: 'pipeline.critique' }, 'warning');
    return sections;
  }
}

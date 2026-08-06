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

  return { sections, context };
}

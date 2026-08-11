/**
 * Narrative Insights Service
 *
 * Generates PE-grade AI commentary from computed analysis results.
 * Uses GPT-4.1 (MODEL_INSIGHTS tier) with a senior PE associate persona.
 *
 * Caching strategy (3 layers, in order of cost):
 *   1. In-process LRU (30-min TTL, ~64 deals).  O(1).
 *   2. Inflight Promise dedup — concurrent requests for the same
 *      (dealId, analysisHash) share a single LLM call.
 *   3. Supabase NarrativeInsightCache table (durable across restarts /
 *      multi-instance deploys). Falls back gracefully if the table or
 *      migration is missing.
 *
 * Without (1) and (2), any user reload or the inline + fullscreen views
 * mounting in parallel each triggered a fresh LLM call — see the
 * 21-call burst captured in `/tmp/langsmith_traces.jsonl` (audit/phase1-2).
 */

import crypto from 'crypto';
import { openai, isAIEnabled, trackedChatCompletion } from '../openai.js';
import { MODEL_INSIGHTS } from '../utils/aiModels.js';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import type { IndustryBenchmark, PortfolioSummary } from './agentMemory.js';

// ─── Types ───────────────────────────────────────────────────

export interface NarrativeInsight {
  headline: string;
  commentary: string;
  conviction: 'bullish' | 'neutral' | 'bearish';
}

export interface InsightsResult {
  modules: Record<string, NarrativeInsight>;
  executiveSummary: string;
  topThreeRisks: string[];
  topThreeStrengths: string[];
  diligencePriorities: string[];
  generatedAt: string;
}

interface DealContext {
  /** Internal Deal.id — populated by `getOrGenerateInsights` so the LLM call
   * trace in LangSmith carries the dealId for filtering/correlation. */
  dealId?: string;
  /** Org.id for the deal — used as trace metadata for org-scoped dashboards. */
  orgId?: string;
  dealName?: string;
  industry?: string;
  dealSize?: number;
  revenue?: number;
  ebitda?: number;
}

interface MemoryContext {
  industry: IndustryBenchmark[];
  portfolio: PortfolioSummary;
}

// ─── Hash ────────────────────────────────────────────────────

export function computeAnalysisHash(analysis: any): string {
  // Exclude volatile fields that change on every call
  const { analyzedAt, ...stable } = analysis;
  return crypto.createHash('md5').update(JSON.stringify(stable)).digest('hex');
}

// ─── L1: In-process memory cache ─────────────────────────────
//
// Survives until the lambda/process recycles. Bounded so a long-lived
// instance with many deals doesn't grow unbounded.

const MEMORY_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MEMORY_MAX_ENTRIES = 64;

interface MemoryEntry {
  insights: InsightsResult;
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryEntry>();

function memoryKey(dealId: string, analysisHash: string): string {
  return `${dealId}:${analysisHash}`;
}

function memoryGet(dealId: string, analysisHash: string): InsightsResult | null {
  const key = memoryKey(dealId, analysisHash);
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  // LRU touch
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.insights;
}

function memorySet(dealId: string, analysisHash: string, insights: InsightsResult): void {
  const key = memoryKey(dealId, analysisHash);
  memoryCache.set(key, { insights, expiresAt: Date.now() + MEMORY_TTL_MS });
  // Evict oldest if over capacity (Map iteration order = insertion order)
  while (memoryCache.size > MEMORY_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    memoryCache.delete(oldestKey);
  }
}

function memoryDeleteForDeal(dealId: string): void {
  const prefix = `${dealId}:`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
}

// ─── L2: Inflight request dedup ──────────────────────────────
//
// Concurrent callers that hit a cold cache should share one LLM call.
// Without this, the inline DealAnalysisSection and the AnalysisFullView
// fullscreen modal both fetch /financials/insights on mount and each
// independently trigger a fresh generation.

const inflight = new Map<string, Promise<InsightsResult>>();

// ─── L3: Supabase durable cache ──────────────────────────────

export async function getCachedInsights(
  dealId: string,
  analysisHash: string,
): Promise<InsightsResult | null> {
  // L1 fast path
  const fromMemory = memoryGet(dealId, analysisHash);
  if (fromMemory) return fromMemory;

  // L3 durable
  try {
    const { data } = await supabase
      .from('NarrativeInsightCache')
      .select('insights')
      .eq('dealId', dealId)
      .eq('analysisHash', analysisHash)
      .single();

    const insights = (data?.insights as InsightsResult | undefined) ?? null;
    if (insights) memorySet(dealId, analysisHash, insights);
    return insights;
  } catch (err) {
    // Cache miss / DB error — caller will regenerate. Log so persistent failures are visible.
    log.warn('narrativeInsights: getCachedInsights failed', { error: err instanceof Error ? err.message : String(err), dealId });
    return null;
  }
}

export async function cacheInsights(
  dealId: string,
  orgId: string,
  analysisHash: string,
  insights: InsightsResult,
): Promise<void> {
  // Always populate L1 — survives even if the durable upsert below fails
  // (e.g. NarrativeInsightCache migration not yet run on this env).
  memorySet(dealId, analysisHash, insights);

  try {
    await supabase
      .from('NarrativeInsightCache')
      .upsert({
        dealId,
        organizationId: orgId,
        analysisHash,
        insights,
        generatedAt: new Date().toISOString(),
      }, { onConflict: 'dealId,analysisHash' });
  } catch (err) {
    log.error('narrativeInsights: cacheInsights failed', err);
  }
}

export async function invalidateCache(dealId: string): Promise<void> {
  memoryDeleteForDeal(dealId);
  try {
    await supabase
      .from('NarrativeInsightCache')
      .delete()
      .eq('dealId', dealId);
  } catch (err) {
    log.error('narrativeInsights: invalidateCache failed', err);
  }
}

// ─── Coordinated entry point (cache + dedup + generate) ──────

export async function getOrGenerateInsights(
  dealId: string,
  orgId: string,
  analysisHash: string,
  analysisResult: any,
  dealContext: DealContext,
  memory: MemoryContext,
): Promise<{ insights: InsightsResult; fromCache: boolean }> {
  // 1. Cache hit?
  const cached = await getCachedInsights(dealId, analysisHash);
  if (cached) return { insights: cached, fromCache: true };

  // 2. Inflight dedup — share an in-progress generation if one exists
  const key = memoryKey(dealId, analysisHash);
  const existing = inflight.get(key);
  if (existing) {
    const insights = await existing;
    return { insights, fromCache: true };
  }

  // 3. Cold path — generate, then cache + clear inflight
  const promise = (async () => {
    // Inject dealId/orgId into the context so downstream LLM calls trace
    // with the right deal attribution in LangSmith.
    const ctxWithIds: DealContext = { ...dealContext, dealId, orgId };
    const insights = await generateNarrativeInsights(analysisResult, ctxWithIds, memory);
    cacheInsights(dealId, orgId, analysisHash, insights).catch(() => {});
    return insights;
  })();
  inflight.set(key, promise);
  try {
    const insights = await promise;
    return { insights, fromCache: false };
  } finally {
    inflight.delete(key);
  }
}

// ─── Condense Analysis ──────────────────────────────────────

function condenseAnalysis(analysis: any): any {
  const condensed: any = {};

  // QoE
  if (analysis.qoe) {
    condensed.qoe = {
      score: analysis.qoe.score,
      summary: analysis.qoe.summary,
      flagCount: analysis.qoe.flags?.length || 0,
      criticalFlags: (analysis.qoe.flags || [])
        .filter((f: any) => f.severity === 'critical' || f.severity === 'warning')
        .map((f: any) => ({ name: f.name, severity: f.severity, detail: f.detail })),
    };
  }

  // Latest period ratios (just trend + latest value)
  if (analysis.ratios?.length) {
    condensed.ratios = analysis.ratios.map((group: any) => ({
      name: group.name,
      ratios: (group.ratios || []).map((r: any) => ({
        name: r.name,
        latestValue: r.periods?.[r.periods.length - 1]?.value,
        trend: r.trend,
        benchmark: r.benchmark,
      })),
    }));
  }

  // Revenue quality
  if (analysis.revenueQuality) {
    condensed.revenueQuality = {
      revenueCAGR: analysis.revenueQuality.revenueCAGR,
      consistencyScore: analysis.revenueQuality.consistencyScore,
    };
  }

  // Cash flow
  if (analysis.cashFlowAnalysis) {
    condensed.cashFlow = {
      avgConversion: analysis.cashFlowAnalysis.avgConversion,
      latestFCF: analysis.cashFlowAnalysis.periods?.[
        analysis.cashFlowAnalysis.periods.length - 1
      ]?.fcf,
    };
  }

  // Working capital
  if (analysis.workingCapital) {
    const latestWc = analysis.workingCapital.periods?.[
      analysis.workingCapital.periods.length - 1
    ];
    condensed.workingCapital = {
      nwcAsPercentRevenue: latestWc?.nwcPctRevenue,
      trend: analysis.workingCapital.trend,
    };
  }

  // Debt capacity
  if (analysis.debtCapacity) {
    condensed.debtCapacity = {
      currentLeverage: analysis.debtCapacity.currentLeverage,
      interestCoverage: analysis.debtCapacity.interestCoverage,
      debtToEquity: analysis.debtCapacity.debtToEquity,
    };
  }

  // LBO screen
  if (analysis.lboScreen) {
    condensed.lboScreen = {
      passesScreen: analysis.lboScreen.passesScreen,
      bestIRR: analysis.lboScreen.scenarios?.reduce(
        (max: number | null, s: any) => (s.irr != null && (max == null || s.irr > max) ? s.irr : max), null),
      entryEbitda: analysis.lboScreen.entryEbitda,
    };
  }

  // Cost structure
  if (analysis.costStructure) {
    condensed.costStructure = {
      breakEvenRevenue: analysis.costStructure.breakEvenRevenue,
      operatingLeverage: analysis.costStructure.operatingLeverage,
    };
  }

  // Red flags
  if (analysis.redFlags?.length) {
    condensed.redFlags = analysis.redFlags.map((f: any) => ({
      name: f.name,
      severity: f.severity,
      detail: f.detail,
    }));
  }

  // EBITDA bridge
  if (analysis.ebitdaBridge?.periods?.length) {
    const latest = analysis.ebitdaBridge.periods[analysis.ebitdaBridge.periods.length - 1];
    condensed.ebitdaBridge = {
      latestReported: latest?.reportedEbitda,
      latestAdjusted: latest?.adjustedEbitda,
    };
  }

  condensed.periods = analysis.periods;
  condensed.periodCount = analysis.periods?.length || 0;

  return condensed;
}

// ─── System Prompt ───────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior PE associate writing investment committee commentary for a lower middle market private equity firm.

Your audience: Managing Directors and Partners making investment decisions.

RULES:
- Be direct and analytical. Lead with the conclusion, then the evidence.
- Every insight must be 2-4 sentences. No fluff.
- Frame findings in terms of: (a) investment risk, (b) value creation potential, (c) diligence priorities.
- If data is insufficient, say so explicitly rather than speculating.
- Use conviction levels: "bullish" = clearly positive, "bearish" = clearly concerning, "neutral" = mixed/insufficient.
- Reference specific numbers when making claims.
- Compare against industry benchmarks and portfolio context when available.

BAD insight: "Revenue grew 42% year-over-year." (Just restating a number)
GOOD insight: "Revenue quality is concerning. The -28% CAGR suggests structural decline rather than cyclical softness, significantly below the 5-15% typical for this industry. Recommend a customer cohort analysis to isolate whether decline is concentration-driven."

Return valid JSON matching the requested schema exactly.`;

// ─── Generate ────────────────────────────────────────────────

export async function generateNarrativeInsights(
  analysisResult: any,
  dealContext: DealContext,
  memory: MemoryContext,
): Promise<InsightsResult> {
  if (!isAIEnabled() || !openai) {
    return fallbackInsights();
  }

  const condensed = condenseAnalysis(analysisResult);

  // Build memory context string
  let memorySection = '';
  if (memory.industry.length > 0) {
    memorySection += '\n[INDUSTRY BENCHMARKS]\n';
    for (const b of memory.industry) {
      memorySection += `${b.metric}: typical range ${b.typicalLow}-${b.typicalHigh} (median ${b.typicalMid}, n=${b.sampleSize})\n`;
    }
  }
  if (memory.portfolio.dealCount > 0) {
    memorySection += '\n[PORTFOLIO CONTEXT — firm historical deals]\n';
    memorySection += `Deals analyzed: ${memory.portfolio.dealCount}\n`;
    if (memory.portfolio.medianEbitdaMargin != null) memorySection += `Median EBITDA margin: ${memory.portfolio.medianEbitdaMargin}%\n`;
    if (memory.portfolio.medianRevenueCAGR != null) memorySection += `Median revenue CAGR: ${memory.portfolio.medianRevenueCAGR}%\n`;
    if (memory.portfolio.medianQoeScore != null) memorySection += `Median QoE score: ${memory.portfolio.medianQoeScore}/100\n`;
    if (memory.portfolio.medianFcfConversion != null) memorySection += `Median FCF conversion: ${memory.portfolio.medianFcfConversion}%\n`;
    if (memory.portfolio.lboPassRate != null) memorySection += `LBO screen pass rate: ${memory.portfolio.lboPassRate}%\n`;
  }

  const userPrompt = `Generate PE investment insights for this deal.

[DEAL]
Name: ${dealContext.dealName || 'Unknown'}
Industry: ${dealContext.industry || 'Not specified'}
${dealContext.dealSize ? `Deal Size: $${dealContext.dealSize}M` : ''}
${dealContext.revenue ? `Revenue: $${dealContext.revenue}M` : ''}
${dealContext.ebitda ? `EBITDA: $${dealContext.ebitda}M` : ''}

[ANALYSIS DATA]
${JSON.stringify(condensed, null, 2)}
${memorySection}

Return JSON:
{
  "modules": {
    "qoe": { "headline": "...", "commentary": "...", "conviction": "bullish|neutral|bearish" },
    "revenueQuality": { "headline": "...", "commentary": "...", "conviction": "..." },
    "ebitdaBridge": { "headline": "...", "commentary": "...", "conviction": "..." },
    "cashFlow": { "headline": "...", "commentary": "...", "conviction": "..." },
    "workingCapital": { "headline": "...", "commentary": "...", "conviction": "..." },
    "debtCapacity": { "headline": "...", "commentary": "...", "conviction": "..." },
    "lboScreen": { "headline": "...", "commentary": "...", "conviction": "..." },
    "costStructure": { "headline": "...", "commentary": "...", "conviction": "..." },
    "redFlags": { "headline": "...", "commentary": "...", "conviction": "..." }
  },
  "executiveSummary": "3-sentence overall investment thesis commentary",
  "topThreeRisks": ["risk1", "risk2", "risk3"],
  "topThreeStrengths": ["strength1", "strength2", "strength3"],
  "diligencePriorities": ["priority1", "priority2", "priority3"]
}`;

  try {
    const response = await trackedChatCompletion(
      'narrative_insights',
      {
        model: MODEL_INSIGHTS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 4000,
      },
      undefined,
      {
        tags: ['narrative_insights', 'analysis', dealContext.industry ?? 'unknown_industry'],
        traceMeta: {
          dealId: dealContext.dealId,
          orgId: dealContext.orgId,
          dealName: dealContext.dealName,
          industry: dealContext.industry,
        },
      },
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    const parsed = JSON.parse(content) as InsightsResult;
    parsed.generatedAt = new Date().toISOString();

    // Validate structure
    if (!parsed.modules || !parsed.executiveSummary) {
      throw new Error('Invalid response structure');
    }

    return parsed;
  } catch (err) {
    log.error('narrativeInsights: AI generation failed', err);
    return fallbackInsights();
  }
}

// ─── Fallback ────────────────────────────────────────────────

function fallbackInsights(): InsightsResult {
  return {
    modules: {},
    executiveSummary: 'AI insights are currently unavailable. Review the quantitative analysis above for key metrics.',
    topThreeRisks: [],
    topThreeStrengths: [],
    diligencePriorities: [],
    generatedAt: new Date().toISOString(),
  };
}

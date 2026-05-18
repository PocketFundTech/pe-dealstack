// ─── Deal Signal Monitoring Agent ────────────────────────────────────
// Scheduled LangGraph agent: for each portfolio company →
// analyze context → classify signal type → route action.
// Uses LangGraph checkpointing so partial runs can resume.

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { isLLMAvailable, invokeStructured } from '../../llm.js';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';
import { runWithAgentBounds } from '../agentBounds.js';

// ─── Bounds ──────────────────────────────────────────────────────────
// 3-node sequential DAG (fetch → analyze → route). 30s covers a batch
// analysis call over up to 30 deals; recursionLimit 10 is conservative.
const SIGNAL_MONITOR_TIMEOUT_MS = 30_000;
const SIGNAL_MONITOR_RECURSION_LIMIT = 10;

// ─── State Schema ──────────────────────────────────────────────────

const SignalState = Annotation.Root({
  organizationId: Annotation<string>,
  deals: Annotation<Array<{
    id: string;
    name: string;
    industry: string | null;
    company: string | null;
    revenue: number | null;
    stage: string;
  }>>,
  signals: Annotation<Array<{
    dealId: string;
    dealName: string;
    signalType: string;
    severity: string;
    title: string;
    description: string;
    suggestedAction: string;
  }>>,
  processedCount: Annotation<number>,
  status: Annotation<string>,
  error: Annotation<string | null>,
});

// ─── Node: Fetch Portfolio ─────────────────────────────────────────

async function fetchPortfolioNode(state: typeof SignalState.State) {
  const { data: deals } = await supabase
    .from('Deal')
    .select(`
      id, name, industry, stage, revenue, ebitda, dealSize,
      company:Company(name)
    `)
    .eq('organizationId', state.organizationId)
    .neq('status', 'PASSED')
    .neq('stage', 'CLOSED_LOST')
    .order('updatedAt', { ascending: false })
    .limit(30);

  return {
    deals: (deals || []).map(d => ({
      id: d.id,
      name: d.name,
      industry: d.industry,
      company: (d.company as any)?.name || null,
      revenue: d.revenue,
      stage: d.stage,
    })),
  };
}

// ─── Node: Analyze Signals ─────────────────────────────────────────

async function analyzeSignalsNode(state: typeof SignalState.State) {
  if (!state.deals || state.deals.length === 0) {
    return { signals: [], processedCount: 0, status: 'completed' };
  }

  // Batch analyze — process all deals at once for efficiency
  const dealsSummary = state.deals.map(d =>
    `- ${d.name} (${d.industry || 'N/A'}): ${d.stage}, Revenue $${d.revenue || 0}M, Company: ${d.company || 'N/A'}`
  ).join('\n');

  try {
    const result = await invokeStructured(z.object({
      signals: z.array(z.object({
        dealName: z.string(),
        signalType: z.enum([
          'leadership_change', 'financial_event', 'market_shift',
          'competitive_threat', 'regulatory_change', 'growth_opportunity',
          'risk_escalation', 'milestone_approaching',
        ]),
        severity: z.enum(['critical', 'warning', 'info']),
        title: z.string().describe('Brief signal title'),
        description: z.string().describe('1-2 sentence explanation'),
        suggestedAction: z.string().describe('Recommended next step'),
      })),
    }), [
      new SystemMessage(`You are a PE deal monitoring system. Analyze the portfolio and generate signals — potential risks, opportunities, or required actions for each deal based on their current status, industry trends, and deal lifecycle.

Signal types:
- leadership_change: Key personnel changes that could affect the deal
- financial_event: Earnings, debt events, or financial milestones
- market_shift: Industry or market trends affecting the deal
- competitive_threat: New competition or market disruption
- regulatory_change: Regulatory developments in the sector
- growth_opportunity: Expansion or acquisition opportunities
- risk_escalation: Increasing risk that needs attention
- milestone_approaching: Upcoming deadlines or milestones

Generate 1-3 signals per deal, focusing on the most actionable ones. Only generate signals that are realistic based on the deal's industry and stage.`),
      new HumanMessage(`Analyze these portfolio deals for signals:\n\n${dealsSummary}\n\nToday's date: ${new Date().toISOString().split('T')[0]}`),
    ], { maxTokens: 3000, temperature: 0.3, label: 'signalMonitor.analyze' });

    // Map deal names back to IDs
    const signals = result.signals.map((s: any) => {
      const deal = state.deals.find(d => d.name === s.dealName);
      return {
        ...s,
        dealId: deal?.id || '',
      };
    }).filter((s: any) => s.dealId);

    return {
      signals,
      processedCount: state.deals.length,
      status: 'completed',
    };
  } catch (error: any) {
    log.error('Signal analysis failed', error);
    return {
      signals: [],
      processedCount: 0,
      status: 'failed',
      error: error.message,
    };
  }
}

// ─── Node: Route & Notify ──────────────────────────────────────────

async function routeSignalsNode(state: typeof SignalState.State) {
  if (!state.signals || state.signals.length === 0) return {};

  // Create notifications for critical and warning signals
  const notifications = state.signals
    .filter(s => s.severity === 'critical' || s.severity === 'warning')
    .map(s => ({
      organizationId: state.organizationId,
      type: 'DEAL_SIGNAL',
      title: `[${s.severity.toUpperCase()}] ${s.title}`,
      message: `${s.dealName}: ${s.description}. Action: ${s.suggestedAction}`,
      metadata: {
        dealId: s.dealId,
        signalType: s.signalType,
        severity: s.severity,
      },
    }));

  if (notifications.length > 0) {
    // Store in Activity table for the deal
    for (const signal of state.signals) {
      if (signal.severity === 'critical' || signal.severity === 'warning') {
        await supabase.from('Activity').insert({
          dealId: signal.dealId,
          type: 'AI_SIGNAL',
          title: `[${signal.severity.toUpperCase()}] ${signal.title}`,
          description: `${signal.description}. Suggested action: ${signal.suggestedAction}`,
        });
      }
    }

    log.info('Signal notifications created', {
      total: state.signals.length,
      critical: state.signals.filter(s => s.severity === 'critical').length,
      warning: state.signals.filter(s => s.severity === 'warning').length,
    });
  }

  return {};
}

// ─── Graph Wiring ──────────────────────────────────────────────────

const graph = new StateGraph(SignalState)
  .addNode('fetchPortfolio', fetchPortfolioNode)
  .addNode('analyzeSignals', analyzeSignalsNode)
  .addNode('routeSignals', routeSignalsNode)
  .addEdge(START, 'fetchPortfolio')
  .addEdge('fetchPortfolio', 'analyzeSignals')
  .addEdge('analyzeSignals', 'routeSignals')
  .addEdge('routeSignals', END);

const compiledGraph = graph.compile();

// ─── Public API ────────────────────────────────────────────────────

export interface SignalMonitorResult {
  status: string;
  signals: Array<{
    dealId: string;
    dealName: string;
    signalType: string;
    severity: string;
    title: string;
    description: string;
    suggestedAction: string;
  }>;
  processedCount: number;
  error?: string | null;
}

export async function runSignalMonitor(organizationId: string): Promise<SignalMonitorResult> {
  if (!isLLMAvailable()) {
    return { status: 'failed', signals: [], processedCount: 0, error: 'No LLM provider configured' };
  }

  log.info('Running deal signal monitor', { organizationId });

  const result: any = await runWithAgentBounds(
    (config) =>
      compiledGraph.invoke(
        {
          organizationId,
          deals: [],
          signals: [],
          processedCount: 0,
          status: 'pending',
          error: null,
        },
        config,
      ),
    {
      timeoutMs: SIGNAL_MONITOR_TIMEOUT_MS,
      recursionLimit: SIGNAL_MONITOR_RECURSION_LIMIT,
      envVar: 'SIGNAL_MONITOR_TIMEOUT_MS',
      label: 'Signal monitor agent',
    },
  );

  return {
    status: result.status,
    signals: result.signals,
    processedCount: result.processedCount,
    error: result.error,
  };
}

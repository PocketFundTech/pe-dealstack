// ─── Portfolio AI Routes — LangChain Agent ──────────────────────────
// Portfolio chat uses tools to query pipeline data on demand.
// Market sentiment uses the fast model.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getChatModel, getFastModel, isLLMAvailable } from '../services/llm.js';
import { AICache } from '../services/aiCache.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { getFirmContextBlock } from '../services/firmContextService.js';

const subRouter = Router();

// ─── Portfolio Tools (closure-bound per request) ──────────────────

function getPortfolioTools(orgId: string) {
  const getPortfolioSummaryTool = tool(
    async () => {
      const { data: deals } = await supabase
        .from('Deal')
        .select('id, name, stage, status, industry, revenue, ebitda, dealSize, irrProjected, mom, aiThesis, createdAt')
        .eq('organizationId', orgId)
        .order('updatedAt', { ascending: false });

      const active = deals?.filter(d => d.status !== 'PASSED' && d.stage !== 'CLOSED_LOST') || [];
      const totalRevenue = active.reduce((s, d) => s + (d.revenue || 0), 0);
      const totalEbitda = active.reduce((s, d) => s + (d.ebitda || 0), 0);
      const withIRR = active.filter(d => d.irrProjected);
      const avgIRR = withIRR.length > 0 ? withIRR.reduce((s, d) => s + (d.irrProjected || 0), 0) / withIRR.length : 0;

      const stageCount: Record<string, number> = {};
      const industryCount: Record<string, number> = {};
      active.forEach(d => {
        stageCount[d.stage] = (stageCount[d.stage] || 0) + 1;
        if (d.industry) industryCount[d.industry] = (industryCount[d.industry] || 0) + 1;
      });

      const parts: string[] = [
        `Total Deals: ${deals?.length || 0} (${active.length} active)`,
        `Total Revenue: $${totalRevenue.toFixed(1)}M`,
        `Total EBITDA: $${totalEbitda.toFixed(1)}M`,
        `Average IRR: ${avgIRR.toFixed(1)}%`,
        `\nBy Stage: ${Object.entries(stageCount).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `By Industry: ${Object.entries(industryCount).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `\nTop 10 Deals:`,
      ];
      for (const d of active.slice(0, 10)) {
        parts.push(`- ${d.name} (${d.industry || 'N/A'}): ${d.stage}, Rev $${d.revenue || 0}M, EBITDA $${d.ebitda || 0}M`);
      }
      return parts.join('\n');
    },
    {
      name: 'get_portfolio_summary',
      description: 'Get full portfolio summary: deal counts, revenue, EBITDA, IRR, stage/industry breakdown, and top deals.',
      schema: z.object({}),
    }
  );

  const getDealDetailsTool = tool(
    async ({ dealName }) => {
      const { data: deals } = await supabase
        .from('Deal')
        .select('id, name, stage, status, industry, revenue, ebitda, dealSize, irrProjected, mom, aiThesis, description, source')
        .eq('organizationId', orgId)
        .ilike('name', `%${dealName}%`)
        .limit(3);

      if (!deals || deals.length === 0) return `No deal found matching "${dealName}".`;

      const results: string[] = [];
      for (const d of deals) {
        const parts = [`**${d.name}**`, `Stage: ${d.stage}, Status: ${d.status}`];
        if (d.industry) parts.push(`Industry: ${d.industry}`);
        if (d.revenue) parts.push(`Revenue: $${d.revenue}M`);
        if (d.ebitda) parts.push(`EBITDA: $${d.ebitda}M`);
        if (d.dealSize) parts.push(`Deal Size: $${d.dealSize}M`);
        if (d.irrProjected) parts.push(`IRR: ${d.irrProjected}%`);
        if (d.mom) parts.push(`MoM: ${d.mom}x`);
        if (d.aiThesis) parts.push(`Thesis: ${d.aiThesis}`);

        // Fetch extracted financial statements for this deal
        const { data: statements } = await supabase
          .from('FinancialStatement')
          .select('statementType, period, extractedData, confidence')
          .eq('dealId', d.id)
          .eq('isActive', true)
          .order('period', { ascending: false })
          .limit(6);

        if (statements && statements.length > 0) {
          parts.push(`\nExtracted Financial Statements (${statements.length} periods):`);
          for (const s of statements.slice(0, 3)) {
            const items = Array.isArray(s.extractedData) ? s.extractedData : [];
            const rev = items.find((i: any) => i.label?.toLowerCase().includes('revenue'));
            const ebitda = items.find((i: any) => i.label?.toLowerCase().includes('ebitda'));
            parts.push(`  ${s.statementType} ${s.period}: ${rev ? `Revenue $${rev.value}M` : ''} ${ebitda ? `EBITDA $${ebitda.value}M` : ''} (${s.confidence}% confidence)`);
          }
        }

        results.push(parts.join('\n'));
      }
      return results.join('\n\n');
    },
    {
      name: 'get_deal_details',
      description: 'Fetch details for a specific deal by name, including extracted financial statements. Use when user asks about a particular deal.',
      schema: z.object({
        dealName: z.string().describe('Name or partial name of the deal to look up'),
      }),
    }
  );

  const getPipelineAnalysisTool = tool(
    async () => {
      const { data: deals } = await supabase
        .from('Deal')
        .select('stage, status, revenue, ebitda, dealSize, createdAt')
        .eq('organizationId', orgId);

      if (!deals || deals.length === 0) return 'No deals in pipeline.';

      const stages = ['SOURCING', 'SCREENING', 'DUE_DILIGENCE', 'IC_REVIEW', 'LOI', 'CLOSING', 'CLOSED_WON', 'CLOSED_LOST'];
      const parts: string[] = ['**Pipeline Analysis:**\n'];

      for (const stage of stages) {
        const stageDeals = deals.filter(d => d.stage === stage);
        if (stageDeals.length === 0) continue;
        const totalValue = stageDeals.reduce((s, d) => s + (d.dealSize || 0), 0);
        parts.push(`${stage}: ${stageDeals.length} deals, $${totalValue.toFixed(1)}M total value`);
      }

      // Conversion metrics
      const total = deals.length;
      const won = deals.filter(d => d.stage === 'CLOSED_WON').length;
      const lost = deals.filter(d => d.stage === 'CLOSED_LOST' || d.status === 'PASSED').length;
      parts.push(`\nConversion: ${won} won, ${lost} passed/lost out of ${total} total (${total > 0 ? Math.round(won / total * 100) : 0}% win rate)`);

      return parts.join('\n');
    },
    {
      name: 'get_pipeline_analysis',
      description: 'Analyze the deal pipeline — stage distribution, total value per stage, conversion rates.',
      schema: z.object({}),
    }
  );

  return [getPortfolioSummaryTool, getDealDetailsTool, getPipelineAnalysisTool];
}

// ─── Portfolio Chat Route ─────────────────────────────────────────

subRouter.post('/portfolio/chat', async (req, res) => {
  try {
    if (!isLLMAvailable()) {
      return res.status(503).json({ error: 'AI service unavailable' });
    }

    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    const orgId = getOrgId(req);

    const model = getChatModel(0.3, 1500, 'deal_analysis');
    const tools = getPortfolioTools(orgId);

    const agent = createReactAgent({
      llm: model,
      tools,
    });

    // Firm-wide standing context (single AI-generated firm-context doc). Empty
    // when none generated yet — guard and prepend nothing.
    const firmContext = await getFirmContextBlock(orgId);
    const firmContextBlock = firmContext ? `=== FIRM CONTEXT ===\n${firmContext}\n\n` : '';

    const systemPrompt = `${firmContextBlock}You are an AI portfolio assistant for a Private Equity firm. You have tools to query the firm's deal pipeline and portfolio data.

RULES:
- ALWAYS use tools to get data before answering — never guess or assume
- Use get_portfolio_summary for questions about the full portfolio, total counts, or overall metrics (no params needed)
- Use get_deal_details for questions about specific deals (pass the deal name only)
- Use get_pipeline_analysis for stage distribution, conversion, and pipeline value questions (no params needed)
- When asked "which deals need attention": explain WHY each deal needs attention (stalled stage, low revenue, missing metrics, long time without activity)
- Use specific numbers from tool results — cite revenue, EBITDA, stage, and deal names
- Be consistent: always use the same tool for the same type of question
- If asked to compare or summarize multiple deals, use get_portfolio_summary first, then get_deal_details for specifics

Today's date: ${new Date().toLocaleDateString()}`;

    log.info('Portfolio AI query (ReAct agent)', { query: message.substring(0, 50) });

    const result = await agent.invoke({
      messages: [
        new SystemMessage(systemPrompt),
        new HumanMessage(message),
      ],
    });

    // Extract final AI response
    const aiMessages = result.messages.filter(
      (m: any) => m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage'
    );
    const lastAI = aiMessages[aiMessages.length - 1];
    const response = typeof lastAI?.content === 'string'
      ? lastAI.content
      : 'Unable to generate response.';

    // Extract mentioned deals for related deals
    const { data: allDeals } = await supabase
      .from('Deal')
      .select('id, name, stage, industry, revenue')
      .eq('organizationId', orgId)
      .neq('status', 'PASSED')
      .limit(50);

    const mentionedDeals = (allDeals || [])
      .filter(d => response.toLowerCase().includes(d.name.toLowerCase()))
      .slice(0, 3);

    res.json({
      response,
      context: { activeDeals: allDeals?.length || 0 },
      relatedDeals: mentionedDeals.map(d => ({
        id: d.id, name: d.name, stage: d.stage, industry: d.industry, revenue: d.revenue,
      })),
    });
  } catch (error) {
    log.error('Portfolio chat error', error);
    res.status(500).json({ error: 'Failed to process portfolio query' });
  }
});

// ─── Market Sentiment (Fast Model — no change needed) ─────────────

subRouter.get('/ai/market-sentiment', async (req, res) => {
  try {
    if (!isLLMAvailable()) {
      return res.status(503).json({ error: 'AI service unavailable' });
    }

    const cacheKey = 'market-sentiment';
    const cached = await AICache.get(cacheKey);
    if (cached) return res.json(cached);

    const orgId = getOrgId(req);

    const { data: deals } = await supabase
      .from('Deal')
      .select('id, name, industry, stage, status, dealSize')
      .eq('organizationId', orgId)
      .neq('status', 'PASSED')
      .order('updatedAt', { ascending: false })
      .limit(20);

    const industries = [...new Set(deals?.map(d => d.industry).filter(Boolean) || [])];
    const focusSectors = industries.length > 0
      ? industries.slice(0, 5)
      : ['Technology', 'Healthcare', 'Financial Services', 'Consumer', 'Industrial'];

    const activeDeals = deals?.filter(d => d.status !== 'PASSED') || [];
    const dealsByStage: Record<string, number> = {};
    activeDeals.forEach(d => { dealsByStage[d.stage] = (dealsByStage[d.stage] || 0) + 1; });

    const model = getFastModel(0.7, 500, 'deal_analysis');
    const structuredModel = model.withStructuredOutput(z.object({
      headline: z.string().describe('One sentence market headline, max 100 chars'),
      analysis: z.string().describe('2-3 sentences of market analysis'),
      sentiment: z.enum(['BULLISH', 'NEUTRAL', 'BEARISH']),
      confidenceScore: z.number().min(0).max(100),
      recommendation: z.string().describe('One specific actionable recommendation'),
      indicators: z.array(z.object({
        name: z.string(),
        trend: z.enum(['up', 'down', 'stable']),
        detail: z.string(),
      })),
      topSector: z.string(),
      riskFactor: z.string(),
    }));

    const portfolioContext = `Current Portfolio:\n- ${activeDeals.length} active deals\n- Focus sectors: ${focusSectors.join(', ')}\n- Pipeline: ${Object.entries(dealsByStage).map(([k, v]) => `${k}: ${v}`).join(', ')}`;

    let sentimentData;
    try {
      sentimentData = await structuredModel.invoke([
        new SystemMessage(`You are a private equity market analyst. Generate a brief, actionable market sentiment analysis for a PE firm. Current date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`),
        new HumanMessage(`Generate market sentiment for a PE firm with this focus:\n${portfolioContext}\n\nFocus sectors: ${focusSectors.join(', ')}`),
      ]);
    } catch (err) {
      log.warn('ai-portfolio: market sentiment LLM call failed, using fallback', { error: err instanceof Error ? err.message : String(err) });
      sentimentData = {
        headline: 'Market analysis temporarily unavailable',
        analysis: 'Unable to generate analysis at this time.',
        sentiment: 'NEUTRAL' as const,
        confidenceScore: 50,
        recommendation: 'Review your pipeline and prioritize active deals.',
        indicators: [],
        topSector: focusSectors[0] || 'Technology',
        riskFactor: 'Market volatility',
      };
    }

    const result = {
      ...sentimentData,
      generatedAt: new Date().toISOString(),
      focusSectors,
      activeDealsCount: activeDeals.length,
    };

    await AICache.set(cacheKey, result, 5 * 60 * 1000);

    log.info('Market sentiment generated (LangChain)', { sectors: focusSectors, sentiment: sentimentData.sentiment });
    res.json(result);
  } catch (error) {
    log.error('Market sentiment error', error);
    res.status(500).json({ error: 'Failed to generate market sentiment' });
  }
});

export default subRouter;

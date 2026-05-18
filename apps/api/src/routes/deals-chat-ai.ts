// ─── Deal Chat AI Route — ReAct Agent ───────────────────────────────
// Uses LangGraph ReAct agent with LangChain tools for on-demand data
// fetching instead of stuffing everything into the system prompt.

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { isLLMAvailable } from '../services/llm.js';
import { runDealChatAgent } from '../services/agents/dealChatAgent/index.js';
import { generateFallbackResponse } from '../services/chatHelpers.js';

const router = Router();

// ─── Input caps (Task 4.4) ────────────────────────────────────────
// User-supplied text flows into LangGraph context. Cap message length,
// number of history items, and per-item content length so a 1MB
// submission can't burn OpenAI tokens or exceed the model context window.
const chatRequestSchema = z.object({
  message: z.string().min(1).max(10_000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(10_000),
      })
    )
    .max(50)
    .optional()
    .default([]),
});

// ─── Financial Markdown Table Builder ────────────────────────────────
// Transforms raw FinancialStatement rows into LLM-optimized Markdown
// tables grouped by statement type with periods as columns.

interface FinancialRow {
  statementType: string;
  period: string;
  lineItems: Record<string, number | null> | null;
}

const STATEMENT_LABELS: Record<string, string> = {
  INCOME_STATEMENT: 'Income Statement',
  BALANCE_SHEET: 'Balance Sheet',
  CASH_FLOW: 'Cash Flow Statement',
};

function buildFinancialMarkdown(statements: FinancialRow[]): string {
  if (!statements.length) {
    return '\n=== VERIFIED FINANCIAL DATA ===\nNo extracted financial data available yet. Use get_deal_financials tool or ask the user to upload financial documents.';
  }

  // Group by statement type
  const grouped: Record<string, { period: string; data: Record<string, number | null> }[]> = {};
  for (const stmt of statements) {
    if (!stmt.lineItems) continue;
    const data = stmt.lineItems as Record<string, number | null>;
    if (!grouped[stmt.statementType]) grouped[stmt.statementType] = [];
    grouped[stmt.statementType].push({ period: stmt.period, data });
  }

  const sections: string[] = ['\n=== VERIFIED FINANCIAL DATA (Source of Truth — All values in $M USD) ==='];

  for (const [type, entries] of Object.entries(grouped)) {
    const label = STATEMENT_LABELS[type] || type;
    const periods = entries.map(e => e.period);

    // Collect all unique metric keys across periods (preserving insertion order)
    const metricKeys: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const key of Object.keys(entry.data)) {
        if (!seen.has(key)) { seen.add(key); metricKeys.push(key); }
      }
    }

    if (!metricKeys.length) continue;

    // Build Markdown table
    const header = `| Metric | ${periods.join(' | ')} |`;
    const divider = `|--------|${periods.map(() => '-------').join('|')}|`;
    const rows = metricKeys.map(key => {
      const cells = entries.map(e => {
        const val = e.data[key];
        if (val === null || val === undefined) return '—';
        return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
      });
      return `| ${key} | ${cells.join(' | ')} |`;
    });

    sections.push(`\n### ${label}\n${header}\n${divider}\n${rows.join('\n')}`);
  }

  return sections.join('\n');
}

// POST /api/deals/:dealId/chat - Send a message to AI about this deal
router.post('/:dealId/chat', async (req, res) => {
  log.debug('Chat request received', { dealId: req.params.dealId });

  try {
    const { dealId } = req.params;

    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.errors,
      });
    }
    const { message, history } = parsed.data;

    // Verify deal belongs to user's org before any data access
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Get deal with basic context (agent fetches details on demand via tools)
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select(`
        id, name, stage, status, industry, dealSize, revenue, ebitda,
        irrProjected, mom, aiThesis, description, source, organizationId,
        company:Company(id, name, description),
        teamMembers:DealTeamMember(role, user:User(id, name, email, title))
      `)
      .eq('id', dealId)
      .single();

    if (dealError) {
      if (dealError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Deal not found' });
      }
      throw dealError;
    }

    // Check AI availability
    if (!isLLMAvailable()) {
      return res.json({
        response: generateFallbackResponse(message, deal),
        model: 'fallback',
      });
    }

    // Build lightweight deal context (agent tools fetch details on demand)
    const contextParts = [`Deal: ${deal.name}`];
    contextParts.push(`Stage: ${deal.stage}, Status: ${deal.status}`);
    if (deal.industry) contextParts.push(`Industry: ${deal.industry}`);
    if (deal.dealSize) contextParts.push(`Deal Size: $${deal.dealSize}M`);
    if (deal.revenue) contextParts.push(`Revenue: $${deal.revenue}M`);
    if (deal.ebitda) contextParts.push(`EBITDA: $${deal.ebitda}M`);
    if (deal.irrProjected) contextParts.push(`Projected IRR: ${deal.irrProjected}%`);
    if (deal.mom) contextParts.push(`MoM: ${deal.mom}x`);
    if (deal.source) contextParts.push(`Deal Source: ${deal.source}`);
    if (deal.aiThesis) contextParts.push(`Investment Thesis: ${deal.aiThesis}`);

    const company = deal.company as any;
    if (company) {
      contextParts.push(`Company: ${company.name}`);
      if (company.description) contextParts.push(`Description: ${company.description}`);
    }

    const teamMembers = deal.teamMembers as any[];
    if (teamMembers?.length > 0) {
      contextParts.push('\nTeam:');
      for (const m of teamMembers) {
        if (m.user) contextParts.push(`  - ${m.user.name} (${m.role}, ID: ${m.user.id})`);
      }
    }

    // Fetch available users for assignment (same org only)
    const { data: availableUsers } = await supabase
      .from('User')
      .select('id, name, title, role')
      .eq('organizationId', orgId)
      .order('name');

    if (availableUsers?.length) {
      contextParts.push('\nAvailable team members for assignment:');
      for (const u of availableUsers) {
        contextParts.push(`  - ${u.name} (ID: ${u.id}, ${u.title || u.role})`);
      }
    }

    // ─── Firm Profile Context Injection ─────────────────────────────
    // Load the firm's enriched profile so the agent knows investment criteria
    try {
      const { data: orgData } = await supabase
        .from('Organization')
        .select('settings')
        .eq('id', orgId)
        .single();

      const firmProfile = (orgData?.settings as any)?.firmProfile;
      if (firmProfile) {
        contextParts.push('\n=== YOUR FIRM CONTEXT ===');
        if (firmProfile.description) contextParts.push(`Firm: ${firmProfile.description}`);
        if (firmProfile.strategy) contextParts.push(`Strategy: ${firmProfile.strategy}`);
        if (firmProfile.sectors?.length) contextParts.push(`Sectors: ${firmProfile.sectors.join(', ')}`);
        if (firmProfile.checkSizeRange) contextParts.push(`Check Size: ${firmProfile.checkSizeRange}`);
        if (firmProfile.investmentCriteria) contextParts.push(`Investment Criteria: ${firmProfile.investmentCriteria}`);
        if (firmProfile.portfolioCompanies?.length) {
          const names = firmProfile.portfolioCompanies.map((c: any) => c.name).join(', ');
          contextParts.push(`Portfolio: ${names}`);
        }
        if (firmProfile.recentDeals?.length) {
          const deals = firmProfile.recentDeals.map((d: any) => d.title).join(', ');
          contextParts.push(`Recent Deals: ${deals}`);
        }
      }

      // Also inject person context if available
      const { data: userData } = await supabase
        .from('User')
        .select('onboardingStatus')
        .eq('authId', req.user?.id)
        .single();

      const personProfile = (userData?.onboardingStatus as any)?.personProfile;
      if (personProfile?.title) {
        contextParts.push(`\nYour Role: ${personProfile.title}${personProfile.bio ? ' — ' + personProfile.bio : ''}`);
      }
    } catch (err) {
      // Non-blocking — firm context is supplementary
      log.warn('deals-chat-ai: firm context fetch failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // ─── Financial Context Injection ─────────────────────────────────
    // Fetch extracted financial statements and format as LLM-optimized
    // Markdown tables so the agent can do math without tool calls.
    const { data: financialStatements, error: finError } = await supabase
      .from('FinancialStatement')
      .select('statementType, period, lineItems')
      .eq('dealId', dealId)
      .order('statementType')
      .order('period', { ascending: true });

    if (finError) {
      log.error('Failed to fetch financial statements for chat context', { dealId, error: finError });
    }

    const financialContext = buildFinancialMarkdown(financialStatements || []);
    contextParts.push(financialContext);

    // Run the ReAct agent
    const result = await runDealChatAgent({
      dealId,
      orgId: deal.organizationId,
      message,
      dealContext: contextParts.join('\n'),
      history: history.slice(-10),
    });

    // Save messages to database
    const userId = req.user?.id || null;

    await supabase.from('ChatMessage').insert({
      dealId,
      userId,
      role: 'user',
      content: message,
    });

    await supabase.from('ChatMessage').insert({
      dealId,
      userId,
      role: 'assistant',
      content: result.response,
      metadata: {
        model: result.model,
        ...(result.updates && { updates: result.updates }),
        ...(result.action && { action: result.action }),
      },
    });

    await AuditLog.aiChat(req, `Deal: ${deal.name} (ReAct agent)`);

    res.json(result);
  } catch (error) {
    log.error('Error in deal chat', error);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

export default router;

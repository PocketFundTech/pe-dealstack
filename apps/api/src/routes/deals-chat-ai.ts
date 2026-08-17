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
import { runDealChatAgent, runDealChatAgentStreaming } from '../services/agents/dealChatAgent/index.js';
import { generateFallbackResponse } from '../services/chatHelpers.js';
import { getTodayIso } from '../utils/dates.js';
import { formatDealHeadline } from '../utils/financialFormat.js';
import { classifyAIErrorObject } from '../utils/aiErrors.js';

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
  unitScale?: string | null;
  currency?: string | null;
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

  // Group by statement type. Track the unit scale + currency of each
  // statement so the agent prompt tells the LLM what scale the numbers
  // are stored in (formerly hard-coded as "$M USD" — wrong when the
  // source was in actuals / thousands / billions).
  //
  // Default unitScale is ACTUALS (matches `normalizeUnitScale` in
  // financialClassifier.ts — the safest fallback because it means "do
  // not multiply"). Defaulting to MILLIONS would silently inflate values
  // 1,000,000× whenever a row was inserted without a unitScale set.
  const grouped: Record<string, { period: string; data: Record<string, number | null>; unitScale: string; currency: string }[]> = {};
  for (const stmt of statements) {
    if (!stmt.lineItems) continue;
    const data = stmt.lineItems as Record<string, number | null>;
    if (!grouped[stmt.statementType]) grouped[stmt.statementType] = [];
    grouped[stmt.statementType].push({
      period: stmt.period,
      data,
      unitScale: (stmt.unitScale ?? 'ACTUALS').toUpperCase(),
      currency: stmt.currency ?? 'USD',
    });
  }

  // Header reflects the actual scales present rather than assuming MILLIONS.
  // Spell out the multiplier so the LLM can convert correctly when echoing
  // values to the user — e.g. "ACTUALS USD (raw dollars)" makes it unambiguous
  // that "6900" means $6,900, not $6,900M.
  const scaleGloss = (label: string): string => {
    switch (label.split(' ')[0]) {
      case 'ACTUALS':  return ' (raw dollars — multiply by 1)';
      case 'THOUSANDS': return ' (each unit = 1,000)';
      case 'MILLIONS':  return ' (each unit = 1,000,000)';
      case 'BILLIONS':  return ' (each unit = 1,000,000,000)';
      default:          return '';
    }
  };
  const allScales = new Set<string>();
  for (const entries of Object.values(grouped)) {
    for (const e of entries) allScales.add(`${e.unitScale} ${e.currency}`);
  }
  const scaleHeader = allScales.size === 1
    ? [...allScales][0] + scaleGloss([...allScales][0])
    : 'mixed scales — see per-statement labels below';
  const sections: string[] = [`\n=== VERIFIED FINANCIAL DATA (Source of Truth — values in ${scaleHeader}) ===`];

  for (const [type, entries] of Object.entries(grouped)) {
    const label = STATEMENT_LABELS[type] || type;
    const periods = entries.map(e => e.period);

    // Per-statement scale label (covers the multi-statement case where one
    // statement is in MILLIONS but another came from a doc in ACTUALS).
    const stmtScales = new Set(entries.map(e => `${e.unitScale} ${e.currency}`));
    const stmtScaleSuffix = stmtScales.size === 1
      ? ` (values in ${[...stmtScales][0]}${scaleGloss([...stmtScales][0])})`
      : '';

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

    sections.push(`\n### ${label}${stmtScaleSuffix}\n${header}\n${divider}\n${rows.join('\n')}`);
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

    // Get deal with basic context (agent fetches details on demand via tools).
    // Pull the cached* columns alongside the legacy ones so formatDealHeadline
    // can render at the right unit (cached fields are ACTUAL DOLLARS, legacy
    // are MILLIONS by convention — see dealCacheWriteback.ts).
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select(`
        id, name, stage, status, industry, dealSize, revenue, ebitda,
        currency, cachedRevenue, cachedEbitda, cachedEbitdaMargin,
        cachedPeriod, cachedCurrency,
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

    // Check AI availability (lazy-load LLM stack so lite bundle stays light)
    const { isLLMAvailable } = await import('../services/llm.js');
    if (!isLLMAvailable()) {
      return res.json({
        response: generateFallbackResponse(message, deal),
        model: 'fallback',
      });
    }

    // Build lightweight deal context (agent tools fetch details on demand).
    // Headline metrics are formatted via formatDealHeadline so the rendered
    // string honours the actual stored scale: $6,900 ACTUALS renders as
    // "$6.9K", not "$6,900M". The previous code hardcoded "M" which silently
    // misrepresented every non-MILLIONS deal in the agent's context.
    const contextParts = [`Deal: ${deal.name}`];
    contextParts.push(`Stage: ${deal.stage}, Status: ${deal.status}`);
    if (deal.industry) contextParts.push(`Industry: ${deal.industry}`);
    const headline = formatDealHeadline(deal);
    if (headline.dealSize) contextParts.push(`Deal Size: ${headline.dealSize}`);
    if (headline.revenue) {
      const periodNote = headline.cachedPeriod ? ` (${headline.cachedPeriod})` : '';
      contextParts.push(`Revenue: ${headline.revenue}${periodNote}`);
    }
    if (headline.ebitda) {
      const periodNote = headline.cachedPeriod ? ` (${headline.cachedPeriod})` : '';
      contextParts.push(`EBITDA: ${headline.ebitda}${periodNote}`);
    }
    if (headline.ebitdaMargin) contextParts.push(`EBITDA Margin: ${headline.ebitdaMargin}`);
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
        // Stored firm-profile fields (see routes/onboarding-firm.ts +
        // settings/FirmProfileSection.tsx): firmName, description, headquarters,
        // founded, aum, investmentFocus, sectorFocus, dealSize, notableDeals,
        // teamSize, website. Some list-like fields (investmentFocus, sectorFocus,
        // notableDeals) may be stored as either a string or a string[].
        const asText = (v: unknown): string | null => {
          if (Array.isArray(v)) return v.filter(Boolean).join(', ') || null;
          if (typeof v === 'string') return v.trim() || null;
          return null;
        };

        contextParts.push('\n=== YOUR FIRM CONTEXT ===');
        if (firmProfile.firmName) contextParts.push(`Firm: ${firmProfile.firmName}`);
        if (firmProfile.description) contextParts.push(`About: ${firmProfile.description}`);
        const strategy = asText(firmProfile.investmentFocus);
        if (strategy) contextParts.push(`Strategy: ${strategy}`);
        const sectors = asText(firmProfile.sectorFocus);
        if (sectors) contextParts.push(`Sectors: ${sectors}`);
        if (firmProfile.dealSize) contextParts.push(`Check Size: ${firmProfile.dealSize}`);
        if (firmProfile.aum) contextParts.push(`AUM: ${firmProfile.aum}`);
        const notableDeals = asText(firmProfile.notableDeals);
        if (notableDeals) contextParts.push(`Notable Deals: ${notableDeals}`);
        if (firmProfile.headquarters) contextParts.push(`Headquarters: ${firmProfile.headquarters}`);
        if (firmProfile.founded) contextParts.push(`Founded: ${firmProfile.founded}`);
        if (firmProfile.teamSize) contextParts.push(`Team Size: ${firmProfile.teamSize}`);
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
      .select('statementType, period, lineItems, unitScale, currency')
      .eq('dealId', dealId)
      .order('statementType')
      .order('period', { ascending: true });

    if (finError) {
      log.error('Failed to fetch financial statements for chat context', { dealId, error: finError });
    }

    const financialContext = buildFinancialMarkdown(financialStatements || []);
    contextParts.push(financialContext);

    const dealContext = contextParts.join('\n');
    const userId = req.user?.id || null;

    if (process.env.DEAL_CHAT_ENGINE === 'streaming') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      const send = (event: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      let fullText = '';
      let finalModel = '';
      let truncated = false;
      let finalUpdates: any[] | undefined;
      let finalAction: any;

      try {
        for await (const event of runDealChatAgentStreaming(
          { dealId, orgId: deal.organizationId, message, dealContext, history: history.slice(-10), today: getTodayIso(), userId: userId ?? undefined },
          { signal: abortController.signal },
        )) {
          if (event.type === 'text_delta') fullText += event.text;
          if (event.type === 'update') finalUpdates = [...(finalUpdates ?? []), event.update];
          if (event.type === 'action') finalAction = event.action;
          if (event.type === 'done') { finalModel = event.model; truncated = event.truncated; }
          if (event.type === 'error') truncated = true;
          send(event);
        }

        await supabase.from('ChatMessage').insert({ dealId, userId, role: 'user', content: message });
        await supabase.from('ChatMessage').insert({
          dealId,
          userId,
          role: 'assistant',
          content: fullText,
          metadata: {
            model: finalModel || 'claude-sonnet-5',
            ...(truncated && { truncated: true }),
            ...(finalUpdates && { updates: finalUpdates }),
            ...(finalAction && { action: finalAction }),
          },
        });

        await AuditLog.aiChat(req, `Deal: ${deal.name} (streaming)`);
      } catch (streamErr) {
        log.error('Deal chat streaming failed after headers sent', streamErr);
        // PROD REGRESSION (2026-08-17): an exception thrown before the
        // generator's first yield (e.g. a rejected request the Anthropic API
        // never accepts — see the generate_chart schema fix in the same
        // commit) used to fall straight to `res.end()` here with NO event
        // ever written. HTTP/SSE headers were already sent (200, text/
        // event-stream), so the client's EventSource/fetch-stream reader saw
        // a connection that opened and then closed with zero data frames —
        // no error, no text, nothing. The chat UI rendered a blank reply.
        // Only fix once headers are already committed: emit an `error` SSE
        // event before ending the stream, same shape the client already
        // handles from mid-stream errors (see DealChatStreamEvent 'error').
        if (!fullText) {
          const { userMessage } = classifyAIErrorObject(streamErr);
          send({ type: 'error', message: userMessage });
        }
      } finally {
        res.end();
      }
      return;
    }

    // Run the ReAct agent (legacy path)
    const result = await runDealChatAgent({
      dealId,
      orgId: deal.organizationId,
      message,
      dealContext,
      history: history.slice(-10),
      today: getTodayIso(),
      userId: userId ?? undefined,
    });

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

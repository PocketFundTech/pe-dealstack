import { Router } from 'express';
import { supabase } from '../supabase.js';
import { isAIEnabled, DEAL_ANALYSIS_SYSTEM_PROMPT, generateDealContext, trackedChatCompletion } from '../openai.js';
import { z } from 'zod';
import { AICache } from '../services/aiCache.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { notifyDealTeam, resolveUserId } from './notifications.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import ingestRouter from './ai-ingest.js';
import portfolioRouter from './ai-portfolio.js';
import aiAgentsRouter from './ai-agents.js';
import { runDealChatAgent } from '../services/agents/dealChatAgent/index.js';
import { runGlobalChatAgent, streamGlobalChatAgent } from '../services/agents/globalChatAgent/index.js';
import { isLLMAvailable } from '../services/llm.js';
import { MODEL_REASONING, MODEL_CLASSIFICATION } from '../utils/aiModels.js';
import { classifyAIErrorObject } from '../utils/aiErrors.js';

const router = Router();

// Mount sub-routers for ingest/extract, portfolio/market-sentiment, and AI agents
router.use('/', ingestRouter);
router.use('/', portfolioRouter);
router.use('/', aiAgentsRouter);

// Validation schemas
const chatMessageSchema = z.object({
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

// Global (non-deal-scoped) floating-chat contract: { message, context, history }
const globalChatSchema = z.object({
  message: z.string().min(1),
  context: z.string().default('general'),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
});

// POST /api/ai/chat - Global (org-scoped) AI chat — NON-STREAMING FALLBACK.
// Routes through the org-scoped, tool-using ReAct agent (globalChatAgent).
// Backs the non-deal branch of the frontend AIAssistant. Per-deal chat goes
// through /deals/:dealId/chat instead.
// Response: { response, model, actions? } where actions are proposed actions
// the frontend executes (navigate / draftEmail / createTask / changeStage /
// addNote). This endpoint MUST always work (it's the SSE fallback).
router.post('/ai/chat', async (req, res) => {
  try {
    if (!isLLMAvailable()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'No LLM API key configured',
      });
    }

    const orgId = getOrgId(req);
    const { message, context, history } = globalChatSchema.parse(req.body);

    const result = await runGlobalChatAgent({ orgId, message, context, history });

    res.json({
      response: result.response,
      model: result.model,
      ...(result.actions && { actions: result.actions }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error in global AI chat', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// POST /api/ai/chat/stream - Global (org-scoped) AI chat — SSE STREAMING.
// Same body { message, context, history? }. Emits Server-Sent Events:
//   event: token  data: {"text":"..."}                  — incremental answer text
//   event: tool   data: {"tool":"search_documents","status":"running"|"done"}
//   event: done   data: {"response":"...","model":"...","actions":[...]}
//   event: error  data: {"message":"..."}
// Buffering is disabled (Cache-Control: no-cache, X-Accel-Buffering: no) and
// each event is flushed as it's produced.
router.post('/ai/chat/stream', async (req, res) => {
  // Helper: write one SSE event and flush (flush exists when compression
  // middleware is active; guard for environments without it).
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    (res as any).flush?.();
  };

  try {
    if (!isLLMAvailable()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'No LLM API key configured',
      });
    }

    const orgId = getOrgId(req);
    const { message, context, history } = globalChatSchema.parse(req.body);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as any).flushHeaders?.();

    try {
      for await (const ev of streamGlobalChatAgent({ orgId, message, context, history })) {
        send(ev.event, ev.data);
      }
    } catch (streamErr) {
      // The agent generator maps its own errors to an 'error' event, so this
      // only catches truly unexpected throws mid-stream. Headers are already
      // sent, so we can't change status — emit an error event instead.
      log.error('Error mid-stream in global AI chat stream', streamErr);
      send('error', { message: 'The assistant encountered an error while streaming.' });
    }
    res.end();
  } catch (error) {
    // Pre-stream errors (validation, org scope) — headers not yet sent.
    if (res.headersSent) {
      send('error', { message: 'Request failed.' });
      return res.end();
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error in global AI chat stream', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// POST /api/deals/:dealId/chat - Chat with AI about a deal (ReAct Agent)
router.post('/deals/:dealId/chat', async (req, res) => {
  try {
    if (!isLLMAvailable()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'No LLM API key configured',
      });
    }

    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const { message, history = [] } = chatMessageSchema.parse(req.body);

    // Verify deal belongs to user's org
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Fetch deal data for context string
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select(`
        *,
        company:Company(*)
      `)
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Build deal context string for the agent
    const dealContext = generateDealContext(deal);

    // Run the ReAct agent with tools (search_documents, get_deal_financials, compare_deals, etc.)
    const result = await runDealChatAgent({
      dealId,
      orgId,
      message,
      dealContext,
      history,
      userId: req.user?.id ?? undefined,
    });

    // Log activity (fire-and-forget)
    supabase.from('Activity').insert({
      dealId,
      type: 'NOTE_ADDED',
      title: 'AI Chat Query',
      description: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
      metadata: { type: 'ai_chat' },
    });

    // Save messages to database (fire-and-forget)
    const userId = req.user?.id || null;
    supabase.from('ChatMessage').insert([
      { dealId, userId, role: 'user', content: message },
      { dealId, userId, role: 'assistant', content: result.response, metadata: { model: result.model } },
    ]);

    res.json({
      response: result.response,
      model: result.model,
      dealId,
      ...(result.updates && { updates: result.updates }),
      ...(result.action && { action: result.action }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error in AI chat', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// GET /api/deals/:dealId/chat/history - Get chat history for a deal
router.get('/deals/:dealId/chat/history', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const { data: messages, error } = await supabase
      .from('ChatMessage')
      .select('id, role, content, metadata, createdAt')
      .eq('dealId', dealId)
      .order('createdAt', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      messages: messages || [],
      dealId,
      count: messages?.length || 0,
    });
  } catch (error) {
    log.error('Error fetching chat history', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// DELETE /api/deals/:dealId/chat/history - Clear chat history for a deal
router.delete('/deals/:dealId/chat/history', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });

    const { error } = await supabase
      .from('ChatMessage')
      .delete()
      .eq('dealId', dealId);

    if (error) throw error;

    res.json({ success: true, message: 'Chat history cleared' });
  } catch (error) {
    log.error('Error clearing chat history', error);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

// POST /api/deals/:dealId/generate-thesis - Generate AI investment thesis
// Query params: ?refresh=true to bypass cache
router.post('/deals/:dealId/generate-thesis', async (req, res) => {
  try {
    if (!isAIEnabled()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'OpenAI API key not configured',
      });
    }

    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });
    const forceRefresh = req.query.refresh === 'true';

    // Check cache first (unless refresh requested)
    if (!forceRefresh) {
      const cached = await AICache.getThesis(dealId);
      if (cached.hit && cached.data) {
        log.debug('Thesis served from cache', { dealId });
        return res.json({
          thesis: cached.data,
          dealId,
          cached: true,
          cacheAge: cached.age,
        });
      }
    }

    // Fetch deal data
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select(`
        *,
        company:Company(*),
        documents:Document(*),
        activities:Activity(*)
      `)
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const prompt = `Based on the following deal information, generate a concise investment thesis (2-3 sentences) that highlights the key opportunity and any notable risks or considerations.

Deal Information:
${generateDealContext(deal)}

Generate a professional investment thesis that a PE analyst would write. Be specific about the opportunity and any flags that need attention.`;

    log.info('Generating thesis for deal', { dealId, forceRefresh });

    const completion = await trackedChatCompletion('deal_analysis', {
      model: MODEL_REASONING,
      messages: [
        { role: 'system', content: DEAL_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 300,
    });

    const thesis = completion.choices[0]?.message?.content || 'Unable to generate thesis.';

    // Store in cache
    await AICache.setThesis(dealId, thesis);

    // Log activity
    await supabase.from('Activity').insert({
      dealId,
      type: 'STATUS_UPDATED',
      title: 'AI Thesis Generated',
      description: forceRefresh ? 'Investment thesis regenerated by AI' : 'Investment thesis automatically generated by AI',
      metadata: { type: 'thesis_generation', refresh: forceRefresh },
    });

    // Notify team: thesis generated (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        notifyDealTeam(dealId, 'AI_INSIGHT', `AI thesis generated for "${deal.name}"`, undefined, internalId || undefined);
      }).catch(err => {
        log.error('Notification error (thesis)', err);
        captureAgentError(err, { context: 'notifyDealTeam:ai_thesis' }, 'warning');
      });
    }

    res.json({
      thesis,
      dealId,
      cached: false,
    });
  } catch (error) {
    log.error('Error generating thesis', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// POST /api/deals/:dealId/analyze-risks - Analyze deal risks
// Query params: ?refresh=true to bypass cache
router.post('/deals/:dealId/analyze-risks', async (req, res) => {
  try {
    if (!isAIEnabled()) {
      return res.status(503).json({
        error: 'AI service unavailable',
        message: 'OpenAI API key not configured',
      });
    }

    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });
    const forceRefresh = req.query.refresh === 'true';

    // Check cache first (unless refresh requested)
    if (!forceRefresh) {
      const cached = await AICache.getRisks(dealId);
      if (cached.hit && cached.data) {
        log.debug('Risks served from cache', { dealId });
        return res.json({
          risks: cached.data,
          dealId,
          cached: true,
          cacheAge: cached.age,
        });
      }
    }

    // Fetch deal data
    const { data: deal, error: dealError } = await supabase
      .from('Deal')
      .select(`
        *,
        company:Company(*),
        documents:Document(*),
        activities:Activity(*)
      `)
      .eq('id', dealId)
      .single();

    if (dealError || !deal) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const prompt = `Analyze the following deal and identify the top 3-5 key risks that an investor should consider. For each risk, provide a severity level (High/Medium/Low) and a brief mitigation suggestion.

Deal Information:
${generateDealContext(deal)}

Format your response as a JSON array of risk objects with fields: title, description, severity, mitigation`;

    log.info('Analyzing risks for deal', { dealId, forceRefresh });

    const completion = await trackedChatCompletion('deal_analysis', {
      model: MODEL_CLASSIFICATION, // GPT-4.1 — requires response_format: json_object (incompatible with Claude)
      messages: [
        { role: 'system', content: DEAL_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });

    let risks;
    try {
      const content = completion.choices[0]?.message?.content || '{"risks":[]}';
      const parsed = JSON.parse(content);
      risks = parsed.risks || parsed;
    } catch (err) {
      log.warn('ai: risk analysis JSON parse failed, using fallback', { error: err instanceof Error ? err.message : String(err), dealId });
      risks = [{ title: 'Analysis Error', description: 'Could not parse risk analysis', severity: 'Medium' }];
    }

    // Store in cache
    await AICache.setRisks(dealId, risks);

    // Notify team: risk analysis complete (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        notifyDealTeam(dealId, 'AI_INSIGHT', `Risk analysis completed for "${deal.name}"`, undefined, internalId || undefined);
      }).catch(err => {
        log.error('Notification error (risks)', err);
        captureAgentError(err, { context: 'notifyDealTeam:ai_risks' }, 'warning');
      });
    }

    res.json({
      risks,
      dealId,
      cached: false,
    });
  } catch (error) {
    log.error('Error analyzing risks', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});

// GET /api/ai/status - Check AI service status
router.get('/ai/status', (req, res) => {
  res.json({
    enabled: isAIEnabled(),
    model: MODEL_REASONING,
  });
});

// GET /api/deals/:dealId/ai-cache - Get cache stats for a deal
router.get('/deals/:dealId/ai-cache', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });
    const stats = await AICache.getStats(dealId);
    res.json(stats);
  } catch (error) {
    log.error('Error getting cache stats', error);
    res.status(500).json({ error: 'Failed to get cache stats' });
  }
});

// DELETE /api/deals/:dealId/ai-cache - Invalidate cache for a deal
router.delete('/deals/:dealId/ai-cache', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) return res.status(404).json({ error: 'Deal not found' });
    await AICache.invalidate(dealId);
    res.json({ success: true, message: 'Cache invalidated' });
  } catch (error) {
    log.error('Error invalidating cache', error);
    res.status(500).json({ error: 'Failed to invalidate cache' });
  }
});

export default router;

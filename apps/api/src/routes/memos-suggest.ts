// ─── Memo metadata suggestion route ───────────────────────────
// POST /api/memos/suggest-meta — given a dealId, return AI-suggested
// {title, description} for a new memo. Used by the deal-chat redirect
// flow to auto-fill the create-memo form on the client.

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { getFastModel, isLLMAvailable } from '../services/llm.js';
import { z } from 'zod';

const router = Router();

const suggestSchema = z.object({ dealId: z.string().uuid() });

// Hard ceiling on the LLM wait. The fast model usually replies in 1-3s,
// but OpenRouter latency can spike. The chat-redirect flow blocks the
// "Setting up memo from deal context" overlay on this call, so we'd
// rather use the deterministic title than have the user staring at a
// spinner. 8s is generous enough to absorb a normal slow response and
// short enough that a hung model doesn't strand the UI.
const SUGGEST_META_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

router.post('/suggest-meta', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const validation = suggestSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });

    const { dealId } = validation.data;

    const { data: deal } = await supabase
      .from('Deal')
      .select('id, name, industry, stage, dealSize, currency, revenue, ebitda, description, aiThesis, company:Company(name, description)')
      .eq('id', dealId)
      .eq('organizationId', orgId)
      .single();

    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // Deterministic fallback title/desc if LLM unavailable
    const fallbackTitle = `${deal.name || 'New Deal'} — Investment Committee Memo`;
    const fallbackDesc = `IC memo for ${deal.name || 'this opportunity'}${deal.industry ? ` (${deal.industry})` : ''}${deal.stage ? ` at ${deal.stage} stage` : ''}.`;

    if (!isLLMAvailable()) {
      return res.json({ title: fallbackTitle, description: fallbackDesc });
    }

    try {
      const model = getFastModel(0.3, 300, 'memo_suggest_meta');
      const dealCtx = JSON.stringify({
        name: deal.name,
        company: (deal as any).company?.name,
        industry: deal.industry,
        stage: deal.stage,
        dealSize: deal.dealSize,
        currency: deal.currency,
        revenue: deal.revenue,
        ebitda: deal.ebitda,
        aiThesis: deal.aiThesis,
        description: deal.description,
        companyDescription: (deal as any).company?.description,
      });

      const prompt = [
        { role: 'system', content: 'You write concise IC memo titles and one-line descriptions for private-equity investment committee memos. Reply with strict JSON only: {"title": "...", "description": "..."}. Title: <= 70 chars, format like "<Deal/Company> — IC Memo" or "<Deal Name> Investment Memo". Description: a single sentence (<=160 chars) summarizing the investment opportunity, citing sector, stage, and size where known. No markdown, no preamble.' },
        { role: 'user', content: `Deal context:\n${dealCtx}\n\nReturn JSON.` },
      ];

      const startedAt = Date.now();
      const result: any = await withTimeout(
        model.invoke(prompt as any),
        SUGGEST_META_TIMEOUT_MS,
        'suggest-meta LLM',
      );
      log.info('suggest-meta LLM ok', { dealId, ms: Date.now() - startedAt });
      const raw = typeof result?.content === 'string' ? result.content : Array.isArray(result?.content) ? result.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('') : '';
      const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      let parsed: { title?: string; description?: string } = {};
      try { parsed = JSON.parse(cleaned); } catch { /* fall through to fallback */ }

      const title = (parsed.title && typeof parsed.title === 'string' && parsed.title.trim()) || fallbackTitle;
      const description = (parsed.description && typeof parsed.description === 'string' && parsed.description.trim()) || fallbackDesc;
      return res.json({ title: title.slice(0, 200), description: description.slice(0, 500) });
    } catch (llmErr: any) {
      log.error('Memo suggest-meta LLM failed; using fallback', llmErr);
      return res.json({ title: fallbackTitle, description: fallbackDesc });
    }
  } catch (error: any) {
    log.error('Memo suggest-meta route failed', error);
    res.status(500).json({ error: 'Failed to suggest memo metadata' });
  }
});

export default router;

// ─── Firm Context Service ───────────────────────────────────────────
// A single AI-generated "house view" brief for the firm — synthesized from
// multiple org signals (firm profile, teaser criteria, deal pipeline, deal-chat
// themes, NDAs, AI-tool usage) and stored on the Organization so it can serve as
// standing global context for the AI assistant.
//
// Storage: Organization.settings.firmContext = { text, generatedAt, sourcesUsed }.
//
// generateFirmContext gathers all sources best-effort (any one failing is
// skipped, never fatal), runs ONE bounded LLM synthesis, persists the result
// (read → spread → update so other settings keys are preserved), and returns it.
//
// getFirmContextBlock is the consumption hook: it returns firmContext.text or ''
// so callers can guard an empty string and inject nothing when absent.

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { supabase } from '../supabase.js';
import { getChatModel } from './llm.js';
import { log } from '../utils/logger.js';
import { formatFinancialValue } from '../utils/financialFormat.js';

const SETTINGS_KEY = 'firmContext';

// Usage-tracking operation label. Reuse 'deal_analysis' so firm-context
// synthesis lands in the same bucket as the other ad-hoc chat/analysis calls.
const SYNTH_OPERATION = 'deal_analysis';

// Per-source character caps keep the synthesis prompt bounded regardless of how
// large any single signal grows.
const CAP_PROFILE = 4000;
const CAP_TEASER = 4000;
const CAP_PIPELINE = 4000;
const CAP_CHAT = 4000;
const CAP_NDA = 2000;
const CAP_USAGE = 2000;

// ─── Public contract ────────────────────────────────────────────────

export interface FirmContext {
  text: string;
  generatedAt: string;
  sourcesUsed: string[];
  /** Set when the text was hand-edited via saveFirmContext. */
  editedAt?: string;
}

/** A gathered source: a human label plus its (already-capped) text body. */
interface SourceResult {
  label: string;
  text: string;
}

// ─── Source gatherers (all best-effort, all bounded) ────────────────

/** Read the full Organization.settings blob once; callers slice what they need. */
async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  const { data: org, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();
  if (error) {
    log.error('firmContext: readSettings failed', error, { orgId });
    return {};
  }
  return (org?.settings ?? {}) as Record<string, unknown>;
}

async function getOrgName(orgId: string): Promise<string> {
  const { data } = await supabase
    .from('Organization')
    .select('name')
    .eq('id', orgId)
    .single();
  return data?.name || 'the firm';
}

/** Source 1 — researched firm-profile facts from settings.firmProfile. */
function gatherFirmProfile(settings: Record<string, unknown>): SourceResult | null {
  try {
    const profile = settings.firmProfile;
    if (!profile || typeof profile !== 'object') return null;
    const text = JSON.stringify(profile, null, 2).slice(0, CAP_PROFILE);
    if (text.trim().length === 0) return null;
    return { label: 'Firm Profile', text };
  } catch (err) {
    log.warn('firmContext: gatherFirmProfile failed', { err: String(err) });
    return null;
  }
}

/** Source 2 — firm-teaser profiles (criteria + systemPrompt) from settings.firmTeaser. */
function gatherFirmTeaser(settings: Record<string, unknown>): SourceResult | null {
  try {
    const cfg = settings.firmTeaser as
      | { profiles?: Array<{ name?: string; systemPrompt?: string; criteria?: Array<{ label?: string; value?: string }> }> }
      | undefined;
    const profiles = Array.isArray(cfg?.profiles) ? cfg!.profiles : [];
    if (profiles.length === 0) return null;

    const blocks = profiles.map((p) => {
      const lines: string[] = [`Profile: ${p.name ?? 'Unnamed'}`];
      const criteria = Array.isArray(p.criteria) ? p.criteria : [];
      if (criteria.length > 0) {
        lines.push('Criteria:');
        for (const c of criteria) lines.push(`  - ${c.label ?? ''}: ${c.value ?? ''}`);
      }
      if (p.systemPrompt) lines.push(`Guidance: ${p.systemPrompt}`);
      return lines.join('\n');
    });

    const text = blocks.join('\n\n').slice(0, CAP_TEASER);
    if (text.trim().length === 0) return null;
    return { label: 'Firm Teaser Criteria', text };
  } catch (err) {
    log.warn('firmContext: gatherFirmTeaser failed', { err: String(err) });
    return null;
  }
}

/**
 * Source 3 — deal pipeline summary. Mirrors globalChatService.buildPortfolioContext:
 * only the canonical, unit-applied cache columns (cachedRevenue/cachedEbitda are
 * actual dollars — see deal-cache-migration.sql) are summed/quoted; legacy unscaled
 * columns are never re-introduced.
 */
async function gatherDealPipeline(orgId: string): Promise<SourceResult | null> {
  try {
    const { data: deals } = await supabase
      .from('Deal')
      .select('name, stage, status, industry, irrProjected, cachedRevenue, cachedEbitda, cachedEbitdaMargin')
      .eq('organizationId', orgId)
      .order('updatedAt', { ascending: false });

    if (!deals || deals.length === 0) return null;

    const active = deals.filter((d) => d.status !== 'PASSED' && d.stage !== 'CLOSED_LOST');

    let totalRevenue = 0;
    let totalEbitda = 0;
    let revCovered = 0;
    let ebitdaCovered = 0;
    for (const d of active) {
      if (d.cachedRevenue != null) { totalRevenue += d.cachedRevenue; revCovered++; }
      if (d.cachedEbitda != null) { totalEbitda += d.cachedEbitda; ebitdaCovered++; }
    }

    const withIRR = active.filter((d) => d.irrProjected);
    const avgIRR = withIRR.length > 0
      ? withIRR.reduce((s, d) => s + (d.irrProjected || 0), 0) / withIRR.length
      : 0;

    const stageCount: Record<string, number> = {};
    const industryCount: Record<string, number> = {};
    for (const d of active) {
      stageCount[d.stage] = (stageCount[d.stage] || 0) + 1;
      if (d.industry) industryCount[d.industry] = (industryCount[d.industry] || 0) + 1;
    }

    const coverageNote = (covered: number) =>
      covered < active.length ? ` (canonical figures for ${covered}/${active.length} active deals)` : '';

    const parts: string[] = [
      `Total Deals: ${deals.length} (${active.length} active)`,
      `Total Revenue (sum of canonical figures): ${formatFinancialValue(totalRevenue, 'ACTUALS', { currency: 'USD' })}${coverageNote(revCovered)}`,
      `Total EBITDA (sum of canonical figures): ${formatFinancialValue(totalEbitda, 'ACTUALS', { currency: 'USD' })}${coverageNote(ebitdaCovered)}`,
      `Average IRR: ${avgIRR.toFixed(1)}%`,
      `By Stage: ${Object.entries(stageCount).map(([k, v]) => `${k}: ${v}`).join(', ') || 'n/a'}`,
      `By Industry: ${Object.entries(industryCount).map(([k, v]) => `${k}: ${v}`).join(', ') || 'n/a'}`,
    ];
    const text = parts.join('\n').slice(0, CAP_PIPELINE);
    return { label: 'Deal Pipeline', text };
  } catch (err) {
    log.warn('firmContext: gatherDealPipeline failed', { err: String(err) });
    return null;
  }
}

/**
 * Source 4 — recurring deal-chat themes. ChatMessage has no organizationId; it's
 * scoped through dealId (see chat-history-migration.sql), so we first resolve the
 * org's deal IDs, then pull a bounded recent sample of USER messages across them
 * and let the LLM infer themes.
 */
async function gatherChatThemes(orgId: string): Promise<SourceResult | null> {
  try {
    const { data: deals } = await supabase
      .from('Deal')
      .select('id')
      .eq('organizationId', orgId)
      .limit(500);

    const dealIds = (deals ?? []).map((d) => d.id).filter(Boolean);
    if (dealIds.length === 0) return null;

    const { data: messages } = await supabase
      .from('ChatMessage')
      .select('content, role, createdAt')
      .in('dealId', dealIds)
      .eq('role', 'user')
      .order('createdAt', { ascending: false })
      .limit(50);

    if (!messages || messages.length === 0) return null;

    const text = messages
      .map((m) => `- ${String(m.content ?? '').replace(/\s+/g, ' ').trim()}`)
      .filter((l) => l.length > 2)
      .join('\n')
      .slice(0, CAP_CHAT);
    if (text.trim().length === 0) return null;
    return { label: 'Deal Chat Themes', text };
  } catch (err) {
    log.warn('firmContext: gatherChatThemes failed', { err: String(err) });
    return null;
  }
}

/** Source 5 — NDAs: counterparties / sectors / titles (bounded count). */
async function gatherNdas(orgId: string): Promise<SourceResult | null> {
  try {
    const { data: docs } = await supabase
      .from('LegalDocument')
      .select('title, counterpartyName, docType, status')
      .eq('organizationId', orgId)
      .is('metadata->>deletedAt', null)
      .order('updatedAt', { ascending: false })
      .limit(50);

    if (!docs || docs.length === 0) return null;

    const text = docs
      .map((d) => {
        const segs = [d.docType || 'DOC', d.title || 'untitled'];
        if (d.counterpartyName) segs.push(`counterparty: ${d.counterpartyName}`);
        if (d.status) segs.push(d.status);
        return `- ${segs.join(' — ')}`;
      })
      .join('\n')
      .slice(0, CAP_NDA);
    if (text.trim().length === 0) return null;
    return { label: 'Legal Documents (NDAs)', text };
  } catch (err) {
    log.warn('firmContext: gatherNdas failed', { err: String(err) });
    return null;
  }
}

/** Source 6 — AI-tool usage: which operations were used most (bounded). */
async function gatherUsage(orgId: string): Promise<SourceResult | null> {
  try {
    const { data: events } = await supabase
      .from('UsageEvent')
      .select('operation')
      .eq('organizationId', orgId)
      .eq('status', 'success')
      .order('createdAt', { ascending: false })
      .limit(1000);

    if (!events || events.length === 0) return null;

    const counts: Record<string, number> = {};
    for (const e of events) {
      const op = e.operation || 'unknown';
      counts[op] = (counts[op] || 0) + 1;
    }
    const ranked = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([op, n]) => `- ${op}: ${n} calls`)
      .join('\n');

    const text = ranked.slice(0, CAP_USAGE);
    if (text.trim().length === 0) return null;
    return { label: 'AI Tool Usage', text };
  } catch (err) {
    log.warn('firmContext: gatherUsage failed', { err: String(err) });
    return null;
  }
}

// ─── Persistence ────────────────────────────────────────────────────

/** Read → spread → update so we never clobber other Organization.settings keys. */
async function persistFirmContext(orgId: string, ctx: FirmContext): Promise<void> {
  const settings = await readSettings(orgId);
  const updatedSettings = { ...settings, [SETTINGS_KEY]: ctx };
  const { error } = await supabase
    .from('Organization')
    .update({ settings: updatedSettings })
    .eq('id', orgId);
  if (error) {
    log.error('firmContext: persist failed', error, { orgId });
    throw error;
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Gather all sources (best-effort), run ONE bounded LLM synthesis, persist the
 * result onto Organization.settings.firmContext, and return it.
 */
export async function generateFirmContext(orgId: string): Promise<FirmContext> {
  const settings = await readSettings(orgId);
  const orgName = await getOrgName(orgId);

  // Gather every source independently — one failing never fails the whole run.
  const results = await Promise.all([
    Promise.resolve(gatherFirmProfile(settings)),
    Promise.resolve(gatherFirmTeaser(settings)),
    gatherDealPipeline(orgId),
    gatherChatThemes(orgId),
    gatherNdas(orgId),
    gatherUsage(orgId),
  ]);

  const sources = results.filter((r): r is SourceResult => r != null && r.text.trim().length > 0);
  const sourcesUsed = sources.map((s) => s.label);

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const signalsBlock = sources.length > 0
    ? sources.map((s) => `### ${s.label}\n${s.text}`).join('\n\n')
    : '(No signals are currently available for this firm.)';

  const systemPrompt = `Write a concise FIRM CONTEXT brief for an internal AI assistant at a PE firm — who the firm is, its thesis/strategy, sectors + check size, what it looks for in deals, how it communicates, and notable patterns. Ground ONLY in the provided signals; do not invent. Output prose the assistant can use as standing context.

Today's date: ${today}
Firm name: ${orgName}`;

  const humanPrompt = `Here are the firm's signals. Synthesize them into the brief.\n\n${signalsBlock}`;

  const model = getChatModel(0.3, 1500, SYNTH_OPERATION);

  log.info('firmContext: synthesizing', { orgId, sourcesUsed });

  const result = await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(humanPrompt),
  ]);

  const text = typeof result.content === 'string'
    ? result.content
    : Array.isArray(result.content)
      ? result.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('')
      : '';

  const ctx: FirmContext = {
    text: (text || '').trim(),
    generatedAt: new Date().toISOString(),
    sourcesUsed,
  };

  await persistFirmContext(orgId, ctx);
  return ctx;
}

/** Read the stored firm context, or null if never generated. */
export async function getFirmContext(orgId: string): Promise<FirmContext | null> {
  const settings = await readSettings(orgId);
  const ctx = settings[SETTINGS_KEY] as FirmContext | undefined;
  if (!ctx || typeof ctx.text !== 'string') return null;
  return ctx;
}

/**
 * Save hand-edited firm-context text. Keeps the existing sourcesUsed, stamps
 * editedAt=now, and refreshes generatedAt to now.
 */
export async function saveFirmContext(orgId: string, text: string): Promise<void> {
  const existing = await getFirmContext(orgId);
  const nowIso = new Date().toISOString();
  const ctx: FirmContext = {
    text: (text || '').trim(),
    generatedAt: nowIso,
    editedAt: nowIso,
    sourcesUsed: existing?.sourcesUsed ?? [],
  };
  await persistFirmContext(orgId, ctx);
}

/**
 * Consumption hook for the AI assistant: returns firmContext.text if present,
 * else ''. Consumers guard the empty string and inject nothing when absent.
 */
export async function getFirmContextBlock(orgId: string): Promise<string> {
  const ctx = await getFirmContext(orgId);
  return ctx?.text ?? '';
}

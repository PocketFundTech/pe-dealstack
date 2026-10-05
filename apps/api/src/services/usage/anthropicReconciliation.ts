// ─── Anthropic usage/cost reconciliation ───────────────────────────
// Compares our own AI usage ledger (Supabase `UsageEvent`, provider =
// 'anthropic') against Anthropic's own billing (Admin API cost_report +
// usage_report/messages) for a single UTC day. Surfaces drift so a bug in
// our pricing table, a missed cache multiplier, or an untracked call site
// shows up as a number instead of a surprise invoice.
//
// The Admin API is raw HTTP only (not in the Anthropic SDK as of
// 2026-09-29). Auth is a separate Admin key (`sk-ant-admin01-...`), never
// the regular API key.
//
// Table `UsageReconciliation` is created by usage-cost-accuracy-migration.sql,
// which the founder runs by hand (this repo's migrations are never
// auto-applied — see project_supabase_migrations). Until that's run, the
// upsert here degrades gracefully: log + skip persistence, still return the
// computed summary so the cron route and any manual caller get a result.

import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { captureAgentError } from '../../utils/sentryHelpers.js';

const ADMIN_API_BASE = 'https://api.anthropic.com/v1/organizations';
const ANTHROPIC_VERSION = '2023-06-01';
const USER_AGENT = 'Mozilla/5.0 (compatible; AviseUsageReconciliation/1.0; +https://lmmos.ai)';

const LEDGER_PAGE_SIZE = 1000;
const REPORT_PAGE_LIMIT = 31;

// Drift only gets reported to logs+Sentry when it's both proportionally
// and absolutely material — a $0.02 rounding difference on a $0.01 day is
// a 200% drift that nobody needs paged for.
const ALERT_DRIFT_PCT = 5;
const ALERT_DRIFT_USD = 0.5;

export interface ReconciliationSummary {
  day: string;
  provider: 'anthropic';
  ledgerCostUsd: number;
  providerCostUsd: number;
  driftUsd: number;
  driftPct: number | null;
  ledgerTokens: number;
  providerTokens: number;
  breakdown: {
    workspaceFilter: string | null;
    costByType: Record<string, number>;
    costByModel: Record<string, number>;
    costByTokenType: Record<string, number>;
    tokensByModel: Record<string, number>;
  };
  persisted: boolean;
  alerted: boolean;
}

interface CostReportResult {
  amount: string;
  currency: string;
  cost_type: string | null;
  description: string | null;
  model: string | null;
  token_type: string | null;
  workspace_id: string | null;
}

interface CostReportBucket {
  starting_at: string;
  ending_at: string;
  results: CostReportResult[];
}

interface CostReportResponse {
  data: CostReportBucket[];
  has_more: boolean;
  next_page: string | null;
}

interface UsageReportResult {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  } | null;
  output_tokens: number;
  model: string | null;
  workspace_id: string | null;
}

interface UsageReportBucket {
  starting_at: string;
  ending_at: string;
  results: UsageReportResult[];
}

interface UsageReportResponse {
  data: UsageReportBucket[];
  has_more: boolean;
  next_page: string | null;
}

function assertValidDay(dayUtc: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) {
    throw new Error(`reconcileAnthropicDay: dayUtc must be YYYY-MM-DD, got "${dayUtc}"`);
  }
}

function dayWindow(dayUtc: string): { startingAt: string; endingAt: string } {
  const start = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`reconcileAnthropicDay: invalid day "${dayUtc}"`);
  }
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startingAt: start.toISOString(), endingAt: end.toISOString() };
}

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    'x-api-key': adminKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'User-Agent': USER_AGENT,
  };
}

/** Matches Anthropic's workspace_id filtering rule: "default" means the org's default workspace (workspace_id === null). */
function workspaceMatches(workspaceId: string | null, filter: string | undefined): boolean {
  if (!filter) return true;
  if (filter === 'default') return workspaceId === null;
  return workspaceId === filter;
}

async function fetchAllPages<T extends { has_more: boolean; next_page: string | null }>(
  url: string,
  adminKey: string,
  label: string,
): Promise<T[]> {
  const pages: T[] = [];
  let nextPage: string | null = null;

  for (;;) {
    const pageUrl = nextPage ? `${url}&page=${encodeURIComponent(nextPage)}` : url;
    const res = await fetch(pageUrl, { headers: adminHeaders(adminKey) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Anthropic Admin API ${label} request failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
      );
    }
    const page = (await res.json()) as T;
    pages.push(page);
    if (!page.has_more || !page.next_page) break;
    nextPage = page.next_page;
  }

  return pages;
}

async function fetchCostReport(
  startingAt: string,
  endingAt: string,
  adminKey: string,
): Promise<CostReportResult[]> {
  const params = new URLSearchParams({
    starting_at: startingAt,
    ending_at: endingAt,
    bucket_width: '1d',
    limit: String(REPORT_PAGE_LIMIT),
  });
  params.append('group_by[]', 'description');
  params.append('group_by[]', 'workspace_id');

  const pages = await fetchAllPages<CostReportResponse>(
    `${ADMIN_API_BASE}/cost_report?${params.toString()}`,
    adminKey,
    'cost_report',
  );

  return pages.flatMap((page) => page.data.flatMap((bucket) => bucket.results));
}

async function fetchUsageReport(
  startingAt: string,
  endingAt: string,
  adminKey: string,
): Promise<UsageReportResult[]> {
  const params = new URLSearchParams({
    starting_at: startingAt,
    ending_at: endingAt,
    bucket_width: '1d',
  });
  params.append('group_by[]', 'model');
  params.append('group_by[]', 'workspace_id');

  const pages = await fetchAllPages<UsageReportResponse>(
    `${ADMIN_API_BASE}/usage_report/messages?${params.toString()}`,
    adminKey,
    'usage_report/messages',
  );

  return pages.flatMap((page) => page.data.flatMap((bucket) => bucket.results));
}

/** Anthropic Admin API cost amounts are decimal strings in CENTS, e.g. "123.45" === $1.2345. */
function centsToUsd(amount: string): number {
  const cents = Number.parseFloat(amount);
  if (Number.isNaN(cents)) return 0;
  return cents / 100;
}

function sumUsageTokens(r: UsageReportResult): number {
  return (
    (r.uncached_input_tokens ?? 0) +
    (r.cache_read_input_tokens ?? 0) +
    (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
    (r.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
    (r.output_tokens ?? 0)
  );
}

function addTo(map: Record<string, number>, key: string | null, value: number): void {
  const k = key ?? 'unknown';
  map[k] = (map[k] ?? 0) + value;
}

/** Ledger side: paginated sum of costUsd + totalTokens for provider='anthropic' in [startingAt, endingAt). */
async function sumLedger(
  startingAt: string,
  endingAt: string,
): Promise<{ costUsd: number; tokens: number; rows: number }> {
  let offset = 0;
  let costUsd = 0;
  let tokens = 0;
  let rows = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('UsageEvent')
      .select('costUsd, totalTokens')
      .eq('provider', 'anthropic')
      .gte('createdAt', startingAt)
      .lt('createdAt', endingAt)
      .range(offset, offset + LEDGER_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Ledger query failed while summing UsageEvent: ${error.message}`);
    }

    const page = data ?? [];
    for (const row of page as Array<{ costUsd: number | null; totalTokens: number | null }>) {
      costUsd += Number(row.costUsd ?? 0);
      tokens += Number(row.totalTokens ?? 0);
    }
    rows += page.length;

    if (page.length < LEDGER_PAGE_SIZE) break;
    offset += LEDGER_PAGE_SIZE;
  }

  return { costUsd, tokens, rows };
}

function isMissingTableError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

export async function reconcileAnthropicDay(
  dayUtc: string,
): Promise<ReconciliationSummary | { skipped: 'no_admin_key' }> {
  assertValidDay(dayUtc);

  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) {
    log.warn('reconcileAnthropicDay: ANTHROPIC_ADMIN_KEY not set — skipping reconciliation', { day: dayUtc });
    return { skipped: 'no_admin_key' };
  }

  const { startingAt, endingAt } = dayWindow(dayUtc);
  const workspaceFilter = process.env.ANTHROPIC_RECONCILE_WORKSPACE_ID || null;

  const [costResults, usageResults, ledger] = await Promise.all([
    fetchCostReport(startingAt, endingAt, adminKey),
    fetchUsageReport(startingAt, endingAt, adminKey),
    sumLedger(startingAt, endingAt),
  ]);

  const costByType: Record<string, number> = {};
  const costByModel: Record<string, number> = {};
  const costByTokenType: Record<string, number> = {};
  let providerCostUsd = 0;

  for (const r of costResults) {
    if (!workspaceMatches(r.workspace_id, workspaceFilter ?? undefined)) continue;
    const usd = centsToUsd(r.amount);
    providerCostUsd += usd;
    addTo(costByType, r.cost_type, usd);
    addTo(costByModel, r.model, usd);
    addTo(costByTokenType, r.token_type, usd);
  }

  const tokensByModel: Record<string, number> = {};
  let providerTokens = 0;

  for (const r of usageResults) {
    if (!workspaceMatches(r.workspace_id, workspaceFilter ?? undefined)) continue;
    const tokens = sumUsageTokens(r);
    providerTokens += tokens;
    addTo(tokensByModel, r.model, tokens);
  }

  const driftUsd = ledger.costUsd - providerCostUsd;
  const driftPct = providerCostUsd !== 0 ? (driftUsd / providerCostUsd) * 100 : null;

  const alerted = driftPct !== null && Math.abs(driftPct) > ALERT_DRIFT_PCT && Math.abs(driftUsd) > ALERT_DRIFT_USD;

  if (alerted) {
    log.warn('Anthropic usage reconciliation drift exceeds threshold', {
      day: dayUtc,
      ledgerCostUsd: ledger.costUsd,
      providerCostUsd,
      driftUsd,
      driftPct,
    });
    captureAgentError(
      new Error(
        `Anthropic usage reconciliation drift ${driftPct!.toFixed(2)}% ($${driftUsd.toFixed(2)}) on ${dayUtc}`,
      ),
      { context: 'usage-reconciliation', day: dayUtc },
      'warning',
    );
  }

  const summary: Omit<ReconciliationSummary, 'persisted' | 'alerted'> = {
    day: dayUtc,
    provider: 'anthropic',
    ledgerCostUsd: ledger.costUsd,
    providerCostUsd,
    driftUsd,
    driftPct,
    ledgerTokens: ledger.tokens,
    providerTokens,
    breakdown: {
      workspaceFilter,
      costByType,
      costByModel,
      costByTokenType,
      tokensByModel,
    },
  };

  let persisted = true;
  const { error: upsertError } = await supabase.from('UsageReconciliation').upsert(
    {
      day: dayUtc,
      provider: 'anthropic',
      ledgerCostUsd: summary.ledgerCostUsd,
      providerCostUsd: summary.providerCostUsd,
      driftUsd: summary.driftUsd,
      driftPct: summary.driftPct,
      ledgerTokens: summary.ledgerTokens,
      providerTokens: summary.providerTokens,
      breakdown: summary.breakdown,
    },
    { onConflict: 'day' },
  );

  if (upsertError) {
    if (isMissingTableError(upsertError)) {
      persisted = false;
      log.warn('reconcileAnthropicDay: UsageReconciliation table does not exist yet — skipping persistence', {
        day: dayUtc,
      });
    } else {
      persisted = false;
      log.error('reconcileAnthropicDay: failed to upsert UsageReconciliation row', {
        day: dayUtc,
        error: upsertError.message,
      });
    }
  }

  return { ...summary, persisted, alerted };
}

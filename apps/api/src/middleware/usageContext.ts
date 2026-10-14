import { AsyncLocalStorage } from 'node:async_hooks';
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export interface UsageContext {
  /** Internal User.id (NOT the Supabase auth UUID). FK target for UsageEvent.userId. */
  userId: string;
  organizationId: string;
  requestId?: string;
  source: 'http' | 'background' | 'test';
  /** Set for cron / webhook / background work with no requesting user (e.g. "cron:signal-scan"). */
  systemSource?: string;
  /** Deal the work belongs to, so per-deal AI cost can be read from UsageEvent.metadata.dealId. */
  dealId?: string;
  /**
   * Set by runWithPendingDeal: usage recorded before the deal exists (the
   * ingest read that decides which deal a document creates) collects here,
   * and bindDealToUsage tags it once the deal is known.
   */
  pendingDealUsage?: Array<{ id: string; metadata: Record<string, unknown> }>;
}

const storage = new AsyncLocalStorage<UsageContext>();

// Cache (authId → internal User.id). The internal id never changes for a given
// auth user, so we can cache it indefinitely. Keeps the middleware to one DB
// query per process lifetime per user.
const authIdToUserId = new Map<string, string>();

export function getUsageContext(): UsageContext | undefined {
  return storage.getStore();
}

export function runWithUsageContext<T>(ctx: UsageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Tag every usage record written inside `fn` with this deal. No-op without a bound context. */
export function runWithDealUsage<T>(dealId: string, fn: () => T): T {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  return storage.run({ ...ctx, dealId }, fn);
}

/**
 * Run work whose deal isn't known yet. Usage recorded inside `fn` before
 * bindDealToUsage is called is remembered so it can be tagged afterwards.
 * Gets its own context copy, so several ingests in one request (bulk, email
 * attachments) never share a deal. No-op without a bound context.
 */
export function runWithPendingDeal<T>(fn: () => T): T {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  return storage.run({ ...ctx, dealId: undefined, pendingDealUsage: [] }, fn);
}

/**
 * Tag the current context with `dealId` — every later usage record carries
 * it, including background work started from here — and back-fill the usage
 * already recorded inside runWithPendingDeal. Never throws.
 */
export async function bindDealToUsage(dealId: string): Promise<void> {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.dealId = dealId;
  const pending = ctx.pendingDealUsage ?? [];
  ctx.pendingDealUsage = undefined;
  await Promise.all(
    pending.map(async (row) => {
      try {
        const { error } = await supabase
          .from('UsageEvent')
          .update({ metadata: { ...row.metadata, dealId } })
          .eq('id', row.id)
          .eq('organizationId', ctx.organizationId);
        if (error) log.warn('bindDealToUsage: tag failed', { usageEventId: row.id, error: error.message });
      } catch (err) {
        log.warn('bindDealToUsage: tag threw', { usageEventId: row.id, err });
      }
    }),
  );
}

/** Usage recorded so far in this runWithPendingDeal scope and not yet tagged. */
export function pendingDealUsage(): Array<{ id: string; metadata: Record<string, unknown> }> {
  return [...(getUsageContext()?.pendingDealUsage ?? [])];
}

/**
 * Take over rows a previous request recorded before its deal existed — the
 * duplicate-check round trip: step 1 reads the document and asks the user,
 * step 2 reuses that read via the signed extraction token. Tagged now if
 * this request already knows its deal, otherwise with the next
 * bindDealToUsage. Never throws.
 */
export async function adoptPendingDealUsage(rows: unknown): Promise<void> {
  const ctx = storage.getStore();
  if (!ctx || !Array.isArray(rows)) return;
  const valid = rows
    .filter((r): r is { id: string; metadata: Record<string, unknown> } =>
      !!r && typeof r === 'object'
      && typeof (r as { id?: unknown }).id === 'string'
      && !!(r as { metadata?: unknown }).metadata
      && typeof (r as { metadata?: unknown }).metadata === 'object')
    .slice(0, 50);
  if (!valid.length) return;
  if (ctx.dealId) {
    const dealId = ctx.dealId;
    ctx.pendingDealUsage = valid;
    await bindDealToUsage(dealId);
    return;
  }
  ctx.pendingDealUsage = [...(ctx.pendingDealUsage ?? []), ...valid];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DEAL_PATH = new RegExp(`/deals/(${UUID})(?:[/?]|$)`, 'i');
const MEMO_PATH = new RegExp(`/memos/(${UUID})(?:[/?]|$)`, 'i');

// memoId → dealId (null = memo has no deal). A memo never changes deal.
const memoDealId = new Map<string, string | null>();

/**
 * The deal a request is about, read from its URL: /deals/:dealId/... directly,
 * /memos/:memoId/... via the memo's deal (scoped to the org). Used to tag the
 * request's AI usage with metadata.dealId.
 */
export async function dealIdForRequest(url: string, organizationId: string): Promise<string | undefined> {
  const deal = DEAL_PATH.exec(url);
  if (deal) return deal[1].toLowerCase();
  const memo = MEMO_PATH.exec(url);
  if (!memo) return undefined;
  const memoId = memo[1].toLowerCase();
  if (memoDealId.has(memoId)) return memoDealId.get(memoId) ?? undefined;
  try {
    const { data } = await supabase
      .from('Memo')
      .select('dealId')
      .eq('id', memoId)
      .eq('organizationId', organizationId)
      .maybeSingle();
    const dealId = (data as { dealId?: string | null } | null)?.dealId ?? null;
    // Only cache a hit: a miss may be another org's memo or a lookup blip.
    if (data) memoDealId.set(memoId, dealId);
    return dealId ?? undefined;
  } catch (err) {
    log.warn('dealIdForRequest: memo lookup threw', { memoId, err });
    return undefined;
  }
}

// orgId → the internal User.id that system usage is attributed to.
const orgSystemUserId = new Map<string, string>();

/**
 * Run work that has no requesting user — cron jobs, webhooks, background
 * processing — with a usage context bound to the organization, so its AI
 * spend is recorded instead of silently dropped ("no usage context bound").
 *
 * UsageEvent.userId is NOT NULL, so the row is attributed to the org's
 * earliest admin (falling back to its earliest user) and marked
 * `metadata.attribution = "system"` with `systemSource` for filtering.
 * An already-bound request context is kept as-is. If the org has no user the
 * work still runs, unrecorded, with a warning.
 */
export async function runAsOrgSystem<T>(
  organizationId: string,
  systemSource: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (getUsageContext()) return fn();
  let userId = orgSystemUserId.get(organizationId);
  if (!userId) {
    try {
      const pick = async (roles: string[] | null) => {
        let q = supabase.from('User').select('id').eq('organizationId', organizationId);
        if (roles) q = q.in('role', roles);
        const { data } = await q.order('createdAt', { ascending: true }).limit(1);
        return (data as Array<{ id: string }> | null)?.[0]?.id;
      };
      userId = (await pick(['ADMIN'])) ?? (await pick(null));
      if (userId) orgSystemUserId.set(organizationId, userId);
    } catch (err) {
      log.error('runAsOrgSystem: org user lookup threw', { err, organizationId });
    }
  }
  if (!userId) {
    log.warn('runAsOrgSystem: no user to attribute system usage to — running unrecorded', {
      organizationId,
      systemSource,
    });
    return fn();
  }
  return storage.run({ userId, organizationId, source: 'background', systemSource }, fn);
}

/**
 * Resolve a Supabase auth UUID (User.authId) to the internal User.id that
 * UsageEvent.userId is a foreign key to. Returns null if it can't be resolved.
 *
 * Use this when starting a background task (where usageContextMiddleware never
 * ran) so its UsageContext carries the internal id and not the auth UUID — the
 * latter fails the FK with 23503.
 */
export async function resolveInternalUserId(authId: string): Promise<string | null> {
  if (!authId) return null;
  const cached = authIdToUserId.get(authId);
  if (cached) return cached;
  try {
    const { data, error } = await supabase
      .from('User')
      .select('id')
      .eq('authId', authId)
      .single();
    if (error || !data?.id) {
      log.warn('resolveInternalUserId: failed to resolve internal User.id', {
        authId,
        error: error?.message,
      });
      return null;
    }
    const internalUserId = data.id as string;
    authIdToUserId.set(authId, internalUserId);
    return internalUserId;
  } catch (err) {
    log.error('resolveInternalUserId: User lookup threw', { err, authId });
    return null;
  }
}

/**
 * Express middleware. Must run AFTER authMiddleware + orgMiddleware so req.user
 * has both id (Supabase auth UUID) and organizationId populated.
 *
 * Resolves req.user.id (which is the AUTH UUID = User.authId) to the internal
 * User.id, because UsageEvent.userId is a foreign key to User.id (not authId).
 * Without this resolution the insert fails with FK 23503.
 */
export async function usageContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authId = req.user?.id;
  const organizationId = req.user?.organizationId;
  if (!authId || !organizationId) {
    return next();
  }

  const internalUserId = await resolveInternalUserId(authId);
  if (!internalUserId) {
    return next();
  }

  const requestId = (req.headers['x-request-id'] as string) || undefined;
  const dealId = await dealIdForRequest(req.originalUrl, organizationId);
  storage.run(
    { userId: internalUserId, organizationId, requestId, source: 'http', ...(dealId ? { dealId } : {}) },
    () => next(),
  );
}

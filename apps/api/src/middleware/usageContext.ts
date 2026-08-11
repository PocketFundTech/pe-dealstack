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
  storage.run(
    { userId: internalUserId, organizationId, requestId, source: 'http' },
    () => next(),
  );
}

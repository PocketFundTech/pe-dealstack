import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { getProvider } from './registry.js';
import type { Integration, SyncOptions, SyncResult } from './types.js';

export async function syncIntegration(
  integration: Integration,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const provider = getProvider(integration.provider);
  try {
    const result = await provider.sync(integration, {
      since: options.since ?? (integration.lastSyncAt ? new Date(integration.lastSyncAt) : undefined),
      backfill: options.backfill ?? false,
    });
    await supabase
      .from('Integration')
      .update({
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null,
        consecutiveFailures: 0,
        status: 'connected',
        updatedAt: new Date().toISOString(),
      })
      .eq('id', integration.id);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown sync error';
    const newFailureCount = (integration.consecutiveFailures ?? 0) + 1;
    await supabase
      .from('Integration')
      .update({
        lastSyncError: message,
        consecutiveFailures: newFailureCount,
        status: newFailureCount >= 3 ? 'error' : integration.status,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', integration.id);
    if (newFailureCount === 3) {
      await emitSyncFailedNotification(integration, message);
    }
    log.error('syncEngine: sync failed', err, {
      integrationId: integration.id,
      provider: integration.provider,
      newFailureCount,
    });
    throw err;
  }
}

const SYNC_TIMEOUT_MS = 60_000;
const SYNC_CONCURRENCY = 5;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

export async function syncAll(options: {
  timeoutMs?: number;
  concurrency?: number;
} = {}): Promise<{
  ranFor: number;
  succeeded: number;
  failed: number;
}> {
  const timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
  const concurrency = options.concurrency ?? SYNC_CONCURRENCY;

  const { data: integrations, error } = await supabase
    .from('Integration')
    .select('*')
    .eq('status', 'connected');
  if (error) throw new Error(`syncAll: ${error.message}`);
  if (!integrations) return { ranFor: 0, succeeded: 0, failed: 0 };

  let succeeded = 0;
  let failed = 0;

  await runWithConcurrency(integrations as Integration[], concurrency, async (row) => {
    try {
      await withTimeout(
        syncIntegration(row),
        timeoutMs,
        `syncIntegration(${row.provider}/${row.id})`
      );
      succeeded++;
    } catch {
      failed++;
    }
  });

  return { ranFor: integrations.length, succeeded, failed };
}

async function emitSyncFailedNotification(integration: Integration, message: string): Promise<void> {
  await supabase.from('Notification').insert({
    userId: integration.userId,
    type: 'INTEGRATION_SYNC_FAILED',
    title: `${integration.provider} sync failing`,
    message: `${message.slice(0, 240)} — open Settings → Integrations to reconnect.`,
  });
}

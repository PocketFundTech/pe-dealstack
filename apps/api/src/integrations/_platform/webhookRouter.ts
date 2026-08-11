import { supabase } from '../../supabase.js';
import { getProvider, isProviderRegistered } from './registry.js';
import { log } from '../../utils/logger.js';
import type { ProviderId } from './types.js';

export type WebhookResult =
  | { ok: true }
  | { ok: false; code: 'PROVIDER_UNKNOWN' | 'INVALID_SIGNATURE' | 'HANDLER_ERROR'; message: string };

export async function routeWebhook(
  providerId: ProviderId,
  headers: Record<string, string>,
  body: unknown,
  rawBody?: Buffer
): Promise<WebhookResult> {
  if (!isProviderRegistered(providerId)) {
    log.warn('webhookRouter: unknown provider', { providerId });
    return { ok: false, code: 'PROVIDER_UNKNOWN', message: `No provider: ${providerId}` };
  }
  try {
    const provider = getProvider(providerId);
    await provider.handleWebhook(headers, body, rawBody);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    log.error('webhookRouter: handler error', err, { providerId });
    if (/invalid signature/i.test(message)) {
      return { ok: false, code: 'INVALID_SIGNATURE', message };
    }
    return { ok: false, code: 'HANDLER_ERROR', message };
  }
}

export async function dedupeAndRecord(params: {
  integrationId: string;
  externalId: string;
  type: string;
  payload?: unknown;
}): Promise<{ duplicate: boolean }> {
  const { error } = await supabase.from('IntegrationEvent').insert({
    integrationId: params.integrationId,
    externalId: params.externalId,
    type: params.type,
    payload: params.payload ?? null,
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') return { duplicate: true };
    throw new Error(`webhookRouter.dedupeAndRecord failed: ${error.message}`);
  }
  return { duplicate: false };
}

export async function markEventProcessed(
  integrationId: string,
  externalId: string,
  error?: string
): Promise<void> {
  const update: Record<string, unknown> = {
    processedAt: new Date().toISOString(),
  };
  if (error !== undefined) update.error = error;
  const { error: dbError } = await supabase
    .from('IntegrationEvent')
    .update(update)
    .eq('integrationId', integrationId)
    .eq('externalId', externalId);
  if (dbError) throw new Error(`webhookRouter.markEventProcessed failed: ${dbError.message}`);
}

/**
 * Outbound webhooks: tell external tools (n8n, Zapier, Make) when something
 * happens in Avise, instead of making them poll.
 *
 * Every delivery is a POST of JSON
 *   { id, event, createdAt, organizationId, data }
 * with headers
 *   Avise-Event:     deal.created
 *   Avise-Delivery:  <uuid>
 *   Avise-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}` with the subscription secret>
 * Receivers verify the signature and reject timestamps older than ~5 minutes.
 *
 * Delivery runs after the response is sent (runAfterResponse), one attempt with
 * a 5 s timeout per subscription; the result is stored on the subscription so
 * admins can see failures in Settings.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { runAfterResponse } from '../utils/afterResponse.js';

export const WEBHOOK_EVENTS = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.deleted',
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'task.created',
  'task.updated',
  'task.completed',
  'document.uploaded',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const DELIVERY_TIMEOUT_MS = 5_000;

export function generateWebhookSecret(): string {
  return 'whsec_' + randomBytes(24).toString('base64url');
}

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

interface Subscription {
  id: string;
  url: string;
  secret: string;
  failureCount: number;
}

/** POST one payload to one subscription and record the outcome. */
export async function deliverWebhook(
  sub: Subscription,
  event: WebhookEvent | 'ping',
  organizationId: string,
  data: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const deliveryId = randomUUID();
  const body = JSON.stringify({ id: deliveryId, event, createdAt: new Date().toISOString(), organizationId, data });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(sub.secret, timestamp, body);

  let status = 0;
  let error: string | undefined;
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Avise-Webhooks/1.0',
        'Avise-Event': event,
        'Avise-Delivery': deliveryId,
        'Avise-Signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = res.status;
    if (!res.ok) error = `Receiver answered HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error && err.name === 'TimeoutError'
      ? `No answer within ${DELIVERY_TIMEOUT_MS / 1000} s`
      : `Could not reach the URL (${err instanceof Error ? err.message : String(err)})`;
  }

  const ok = status >= 200 && status < 300;
  const { error: updErr } = await supabase
    .from('WebhookSubscription')
    .update({
      lastDeliveryAt: new Date().toISOString(),
      lastStatus: status || null,
      lastError: ok ? null : error ?? null,
      failureCount: ok ? 0 : (sub.failureCount ?? 0) + 1,
    })
    .eq('id', sub.id);
  if (updErr) log.warn('Webhook delivery status not saved', { subscriptionId: sub.id, error: updErr.message });

  if (!ok) log.warn('Webhook delivery failed', { subscriptionId: sub.id, event, status, error });
  return { ok, status, error };
}

/**
 * Queue `event` for every active subscription in the org that listens to it.
 * Never throws and never delays the response.
 */
export function emitWebhookEvent(req: Request, organizationId: string | undefined, event: WebhookEvent, data: unknown): void {
  if (!organizationId) return;
  void runAfterResponse(req, async () => {
    const { data: subs, error } = await supabase
      .from('WebhookSubscription')
      .select('id, url, secret, failureCount')
      .eq('organizationId', organizationId)
      .eq('active', true)
      .contains('events', [event]);
    if (error) {
      // Table missing before the migration runs, or a transient error: skip quietly.
      log.debug('Webhook subscription lookup skipped', { event, error: error.message });
      return;
    }
    await Promise.all((subs ?? []).map((sub) => deliverWebhook(sub as Subscription, event, organizationId, data)));
  });
}

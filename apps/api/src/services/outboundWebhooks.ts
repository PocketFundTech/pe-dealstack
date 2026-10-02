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
import { BlockedAddressError, safePostJson } from './safeHttpPost.js';

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
// After this many failures in a row the subscription is paused, so a dead URL
// doesn't cost a 5 s timeout on every event forever. Resume it in Settings.
const AUTO_PAUSE_AFTER_FAILURES = 20;

// Heavy fields never leave Avise in a webhook: full document text, embeddings,
// and nested collections. Receivers fetch details via the API if they need them.
const OMIT_KEYS = new Set(['documents', 'activities', 'folders', 'extractedText', 'extractedData', 'embedding', 'chunks']);

export function toWebhookData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => !OMIT_KEYS.has(k)));
}

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
  const body = JSON.stringify({ id: deliveryId, event, createdAt: new Date().toISOString(), organizationId, data: toWebhookData(data) });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(sub.secret, timestamp, body);

  let status = 0;
  let error: string | undefined;
  try {
    const res = await safePostJson(
      sub.url,
      {
        'Content-Type': 'application/json',
        'User-Agent': 'Avise-Webhooks/1.0',
        'Avise-Event': event,
        'Avise-Delivery': deliveryId,
        'Avise-Signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      DELIVERY_TIMEOUT_MS,
    );
    status = res.status;
    if (status < 200 || status >= 300) error = `Receiver answered HTTP ${status}`;
  } catch (err) {
    if (err instanceof BlockedAddressError) error = `Blocked: ${err.message}`;
    else if (err instanceof Error && err.name === 'TimeoutError') error = `No answer within ${DELIVERY_TIMEOUT_MS / 1000} s`;
    else error = 'Could not reach the URL (DNS or connection failed)';
  }

  const ok = status >= 200 && status < 300;
  const failureCount = ok ? 0 : (sub.failureCount ?? 0) + 1;
  const { error: updErr } = await supabase
    .from('WebhookSubscription')
    .update({
      lastDeliveryAt: new Date().toISOString(),
      lastStatus: status || null,
      lastError: ok ? null : error ?? null,
      failureCount,
      ...(failureCount >= AUTO_PAUSE_AFTER_FAILURES ? { active: false } : {}),
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
    // Never let a webhook problem surface as an unhandled rejection: when no
    // after-response hook exists (local dev, tests) this runs inline.
    try {
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
    } catch (err) {
      log.warn('Webhook emit failed', { event, error: err instanceof Error ? err.message : String(err) });
    }
  }).catch(() => {});
}

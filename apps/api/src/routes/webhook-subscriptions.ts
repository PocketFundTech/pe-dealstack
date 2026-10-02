import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { isPrivateUrl } from '../utils/urlHelpers.js';
import { log } from '../utils/logger.js';
import {
  WEBHOOK_EVENTS,
  deliverWebhook,
  generateWebhookSecret,
} from '../services/outboundWebhooks.js';

const router = Router();

// The secret is returned only once, at creation; everything else is listable.
const PUBLIC_FIELDS =
  'id, url, description, events, active, createdAt, lastDeliveryAt, lastStatus, lastError, failureCount' as const;

const urlSchema = z
  .string()
  .url('Enter a full URL, e.g. https://your-n8n.example.com/webhook/avise')
  .max(2048)
  .refine((u) => u.startsWith('https://'), 'Webhook URLs must use https://')
  .refine((u) => !isPrivateUrl(u), 'Webhook URLs cannot point to a private or internal network');

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Pick at least one event')
  .transform((e) => [...new Set(e)]);

const createSchema = z.object({
  url: urlSchema,
  events: eventsSchema,
  description: z.string().trim().max(120).optional(),
});

const updateSchema = z.object({
  url: urlSchema.optional(),
  events: eventsSchema.optional(),
  description: z.string().trim().max(120).nullable().optional(),
  active: z.boolean().optional(),
});

// Admins only. API keys are allowed here (unlike /api-keys) so n8n and
// Zapier can register and remove their own trigger URLs.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role?.toUpperCase() !== 'ADMIN') {
    res.status(403).json({ error: 'Only organization admins can manage webhooks. Ask an admin on your team.' });
    return;
  }
  next();
}

router.use(requireAdmin);

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
const notFound = (res: Response) => res.status(404).json({ error: 'Webhook not found.' });

router.get('/events', (_req: Request, res: Response) => {
  res.json({ events: WEBHOOK_EVENTS });
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('WebhookSubscription')
      .select(PUBLIC_FIELDS)
      .eq('organizationId', getOrgId(req))
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json({ webhooks: data ?? [] });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', details: parsed.error.issues });
    }
    const { data: owner } = await supabase.from('User').select('id').eq('authId', req.user!.id).single();
    const secret = generateWebhookSecret();
    const { data, error } = await supabase
      .from('WebhookSubscription')
      .insert({
        organizationId: getOrgId(req),
        createdById: owner?.id ?? null,
        url: parsed.data.url,
        events: parsed.data.events,
        description: parsed.data.description || null,
        secret,
      })
      .select(PUBLIC_FIELDS)
      .single();
    if (error) throw error;
    log.info('Webhook created', { webhookId: data.id, events: parsed.data.events });
    // The signing secret is returned exactly once.
    res.status(201).json({ webhook: data, secret });
  } catch (err) { next(err); }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isUuid(req.params.id)) return notFound(res);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', details: parsed.error.issues });
    }
    const updates: Record<string, unknown> = { ...parsed.data };
    // Re-enabling clears the failure streak so the status reads fresh.
    if (parsed.data.active === true) updates.failureCount = 0;
    const { data, error } = await supabase
      .from('WebhookSubscription')
      .update(updates)
      .eq('id', req.params.id)
      .eq('organizationId', getOrgId(req))
      .select(PUBLIC_FIELDS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return notFound(res);
    res.json({ webhook: data });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isUuid(req.params.id)) return notFound(res);
    const { data, error } = await supabase
      .from('WebhookSubscription')
      .delete()
      .eq('id', req.params.id)
      .eq('organizationId', getOrgId(req))
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return notFound(res);
    log.info('Webhook deleted', { webhookId: data.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// Send a `ping` event now and report what the receiver answered.
router.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isUuid(req.params.id)) return notFound(res);
    const orgId = getOrgId(req);
    const { data: sub, error } = await supabase
      .from('WebhookSubscription')
      .select('id, url, secret, failureCount')
      .eq('id', req.params.id)
      .eq('organizationId', orgId)
      .maybeSingle();
    if (error) throw error;
    if (!sub) return notFound(res);
    const result = await deliverWebhook(sub, 'ping', orgId, { message: 'Test delivery from Avise' });
    res.json(result);
  } catch (err) { next(err); }
});

export default router;

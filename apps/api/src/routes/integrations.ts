import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { syncIntegration } from '../integrations/_platform/syncEngine.js';
import { getProvider, isProviderRegistered } from '../integrations/_platform/registry.js';
import type { ProviderId, Integration } from '../integrations/_platform/types.js';

const router = Router();

const PROVIDER_IDS: ProviderId[] = [
  'granola', 'gmail', 'google_calendar', 'outlook', 'microsoft365', 'fireflies', 'otter',
];

const PUBLIC_FIELDS = `id, organizationId, userId, provider, status,
  externalAccountId, externalAccountEmail, scopes, settings,
  lastSyncAt, lastSyncError, consecutiveFailures, tokenExpiresAt,
  createdAt, updatedAt` as const;

async function resolveInternalUserId(authId: string): Promise<string | null> {
  const { data } = await supabase
    .from('User').select('id').eq('authId', authId).single();
  return data?.id ?? null;
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const { data, error } = await supabase
      .from('Integration')
      .select(PUBLIC_FIELDS)
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });
    if (error) throw error;
    res.json({ integrations: data ?? [] });
  } catch (err) { next(err); }
});

const connectSchema = z.object({ provider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]) });

const apiKeySchema = z.object({
  apiKey: z.string().min(8).max(512),
});

const activitiesQuerySchema = z.object({
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).refine(v => v.dealId || v.contactId, {
  message: 'dealId or contactId is required',
});

router.post('/:provider/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider } = connectSchema.parse({ provider: req.params.provider });
    if (!isProviderRegistered(provider)) {
      return res.status(404).json({ error: `Provider ${provider} not available yet` });
    }
    const orgId = getOrgId(req);
    const userId = await resolveInternalUserId(req.user!.id);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const result = await getProvider(provider).initiateAuth(userId, orgId);
    // Pass the full InitiateAuthResult through — frontend branches on
    // `mode` to decide between OAuth redirect (authUrl) and api_key paste
    // modal (instructions). Stripping fields here breaks the paste-key flow.
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/:provider/api-key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const provider = (connectSchema.parse({ provider: req.params.provider })).provider;
    if (!isProviderRegistered(provider)) {
      return res.status(404).json({ error: `Provider ${provider} not available yet` });
    }
    const impl = getProvider(provider);
    if (!impl.connectWithApiKey) {
      return res.status(400).json({ error: `Provider ${provider} does not accept API keys` });
    }
    const { apiKey } = apiKeySchema.parse(req.body);
    const orgId = getOrgId(req);
    const userId = await resolveInternalUserId(req.user!.id);
    if (!userId) return res.status(404).json({ error: 'User not found' });
    const integration = await impl.connectWithApiKey({ userId, organizationId: orgId, apiKey });
    res.json({
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      externalAccountEmail: integration.externalAccountEmail,
    });
  } catch (err) {
    if (err instanceof Error && /invalid api key|plan/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.get('/activities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const parsed = activitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
      });
    }
    const params = parsed.data;
    const limit = params.limit ?? 50;

    let q = supabase
      .from('IntegrationActivity')
      .select('id, integrationId, source, externalId, type, dealIds, contactIds, title, summary, occurredAt, durationSeconds, metadata, aiExtraction, createdAt')
      .eq('organizationId', orgId)
      .order('occurredAt', { ascending: false })
      .limit(limit);

    if (params.dealId) q = q.contains('dealIds', [params.dealId]);
    if (params.contactId) q = q.contains('contactIds', [params.contactId]);

    const { data, error } = await q;
    if (error) throw error;
    res.json({ activities: data ?? [] });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const id = req.params.id;
    const { data: row } = await supabase
      .from('Integration')
      .select(PUBLIC_FIELDS)
      .eq('id', id).eq('organizationId', orgId).single();
    if (!row) return res.status(404).json({ error: 'Integration not found' });
    if (isProviderRegistered(row.provider as ProviderId)) {
      try {
        await getProvider(row.provider as ProviderId).disconnect(row as Integration);
      } catch (e) {
        log.warn('Provider disconnect failed (continuing with local revoke)', { e });
      }
    }
    await supabase.from('Integration').update({ status: 'revoked' }).eq('id', id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/sync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const id = req.params.id;
    const { data: row, error } = await supabase
      .from('Integration')
      .select('*')
      .eq('id', id).eq('organizationId', orgId).single();
    if (error || !row) return res.status(404).json({ error: 'Integration not found' });
    const result = await syncIntegration(row as Integration);
    res.json({ ok: true, result });
  } catch (err) { next(err); }
});

router.get('/:id/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const id = req.params.id;
    const { data: integration } = await supabase
      .from('Integration')
      .select('id, organizationId')
      .eq('id', id).eq('organizationId', orgId).single();
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    const { data: events } = await supabase
      .from('IntegrationEvent')
      .select('id, externalId, type, receivedAt, processedAt, error')
      .eq('integrationId', id)
      .order('receivedAt', { ascending: false })
      .limit(50);
    res.json({ events: events ?? [] });
  } catch (err) { next(err); }
});

export default router;

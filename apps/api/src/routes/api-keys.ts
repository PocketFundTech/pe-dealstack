import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId } from '../middleware/orgScope.js';
import { generateApiKey, isMissingColumnError } from '../services/apiKeyService.js';
import { log } from '../utils/logger.js';

const router = Router();

const PUBLIC_FIELDS = 'id, name, scope, keyPrefix, lastFour, createdAt, lastUsedAt, expiresAt, revokedAt, userId' as const;
const PUBLIC_FIELDS_NO_SCOPE = 'id, name, keyPrefix, lastFour, createdAt, lastUsedAt, expiresAt, revokedAt, userId' as const;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name, e.g. "n8n — deal intake"').max(80),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  // 'read_only' can only GET — safe to hand to a less-trusted tool (a BI
  // dashboard, a reporting script) that has no business writing to Avise.
  scope: z.enum(['full', 'read_only']).default('full'),
});

// Managing keys is admin-only, and only from a signed-in session — a leaked
// key must not be able to mint more keys or revoke the owner's other keys.
function requireSessionAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.apiKeyId) {
    res.status(403).json({ error: 'API keys cannot manage API keys. Sign in to Avise and use Settings → API Keys.' });
    return;
  }
  if (req.user?.role?.toUpperCase() !== 'ADMIN') {
    res.status(403).json({ error: 'Only organization admins can manage API keys. Ask an admin on your team.' });
    return;
  }
  next();
}

router.use(requireSessionAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    let { data, error } = await supabase
      .from('ApiKey')
      .select(PUBLIC_FIELDS)
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });

    // ApiKey.scope may not exist yet (api-key-scope-migration.sql not run).
    // Fall back to the old column list rather than 500ing the whole list.
    if (isMissingColumnError(error)) {
      const fallback = await supabase
        .from('ApiKey')
        .select(PUBLIC_FIELDS_NO_SCOPE)
        .eq('organizationId', orgId)
        .order('createdAt', { ascending: false });
      data = (fallback.data ?? []).map((row) => ({ ...row, scope: 'full' as const }));
      error = fallback.error;
    }

    if (error) throw error;
    res.json({ apiKeys: data ?? [] });
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    }
    const orgId = getOrgId(req);
    const { data: owner } = await supabase
      .from('User').select('id').eq('authId', req.user!.id).single();
    if (!owner) return res.status(404).json({ error: 'Your user record was not found. Sign out and back in, then retry.' });

    const { key, keyHash, keyPrefix, lastFour } = generateApiKey();
    const days = parsed.data.expiresInDays;
    const expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    const baseRow = { organizationId: orgId, userId: owner.id, name: parsed.data.name, keyHash, keyPrefix, lastFour, expiresAt };

    let { data, error } = await supabase
      .from('ApiKey')
      .insert({ ...baseRow, scope: parsed.data.scope })
      .select(PUBLIC_FIELDS)
      .single();

    if (isMissingColumnError(error)) {
      if (parsed.data.scope === 'read_only') {
        return res.status(503).json({
          error: 'Read-only keys need a database migration that has not run yet (api-key-scope-migration.sql). Ask your Avise admin, or create a full-access key for now.',
        });
      }
      const fallback = await supabase
        .from('ApiKey')
        .insert(baseRow)
        .select(PUBLIC_FIELDS_NO_SCOPE)
        .single();
      data = fallback.data ? { ...fallback.data, scope: 'full' as const } : null;
      error = fallback.error;
    }

    if (error) throw error;
    if (!data) throw new Error('API key insert returned no row');

    log.info('API key created', { apiKeyId: data.id, orgId, scope: data.scope ?? 'full' });
    // The plaintext key is returned exactly once — it is not stored.
    res.status(201).json({ apiKey: data, key });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return res.status(404).json({ error: 'API key not found, or it was already revoked.' });
    }
    const { data, error } = await supabase
      .from('ApiKey')
      .update({ revokedAt: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('organizationId', getOrgId(req))
      .is('revokedAt', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'API key not found, or it was already revoked.' });
    log.info('API key revoked', { apiKeyId: data.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;

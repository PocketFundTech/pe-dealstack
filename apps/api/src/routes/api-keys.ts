// ─── API key management routes ─────────────────────────────────────
// POST   /api/api-keys      — create key (ADMIN only; raw key returned ONCE)
// GET    /api/api-keys      — list org keys (ADMIN only; never exposes hashes)
// DELETE /api/api-keys/:id  — revoke key (ADMIN only)
//
// Keys themselves cannot call these routes: management requires a real
// admin JWT session (the apiKey middleware assigns VIEWER + requireRole
// blocks it, and creation/revocation are non-GET anyway).

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requireRole } from '../middleware/auth.js';
import { getOrgId } from '../middleware/orgScope.js';
import { generateApiKey, invalidateApiKey } from '../services/apiKeyService.js';
import { logFromRequest, AUDIT_ACTIONS, RESOURCE_TYPES, SEVERITY } from '../services/auditLog.js';
import { resolveUserId } from './notifications.js';
import { log } from '../utils/logger.js';

const router = Router();

router.use(requireRole('ADMIN'));

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
});

// POST /api/api-keys — create a new read-only key
router.post('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { name } = createKeySchema.parse(req.body);

    const { rawKey, keyHash, prefix } = generateApiKey();
    const creatorId = req.user?.id ? await resolveUserId(req.user.id) : null;

    const { data: key, error } = await supabase
      .from('ApiKey')
      .insert({
        organizationId: orgId,
        createdBy: creatorId,
        name,
        keyHash,
        prefix,
        scopes: ['read'],
      })
      .select('id, name, prefix, scopes, createdAt')
      .single();

    if (error) throw error;

    void logFromRequest(req, AUDIT_ACTIONS.API_KEY_CREATED, {
      resourceType: RESOURCE_TYPES.API_KEY,
      resourceId: key.id,
      resourceName: name,
      description: `Created API key: ${name}`,
      severity: SEVERITY.WARNING,
    });

    // The raw key is returned exactly once — only its hash is stored.
    res.status(201).json({ ...key, key: rawKey });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    log.error('API key creation failed', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// GET /api/api-keys — list keys for the org (no hashes, no raw keys)
router.get('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);

    const { data, error } = await supabase
      .from('ApiKey')
      .select('id, name, prefix, scopes, lastUsedAt, revokedAt, createdAt, creator:User!createdBy(id, name, email)')
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    log.error('API key list failed', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// DELETE /api/api-keys/:id — revoke a key
router.delete('/:id', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;

    const { data: key, error } = await supabase
      .from('ApiKey')
      .update({ revokedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('organizationId', orgId)
      .is('revokedAt', null)
      .select('id, name, keyHash')
      .single();

    if (error || !key) {
      return res.status(404).json({ error: 'API key not found or already revoked' });
    }

    invalidateApiKey(key.keyHash);

    void logFromRequest(req, AUDIT_ACTIONS.API_KEY_REVOKED, {
      resourceType: RESOURCE_TYPES.API_KEY,
      resourceId: key.id,
      resourceName: key.name,
      description: `Revoked API key: ${key.name}`,
      severity: SEVERITY.WARNING,
    });

    res.status(204).send();
  } catch (error) {
    log.error('API key revocation failed', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export default router;

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { encryptField, decryptField } from '../services/encryption.js';
import { HubSpotClient } from '../services/hubspot/client.js';
import { runImportBatch } from '../services/hubspot/importEngine.js';
import type { ImportMode } from '../services/hubspot/dedup.js';

const router = Router();
const connectSchema = z.object({ token: z.string().trim().min(10) });
const importSchema = z.object({ mode: z.enum(['fill', 'refresh']).optional() });

const REQUIRED_SCOPES = 'crm.objects.companies.read, crm.objects.contacts.read, crm.objects.deals.read';

function tokenRejectionMessage(v: { status: number; category: string | null }): string {
  if (v.status === 401) return 'HubSpot did not recognize this token. Paste the full Private App access token (it starts with "pat-").';
  if (v.status === 403 || v.category === 'MISSING_SCOPES') {
    return `Your HubSpot Private App is missing required scopes. In HubSpot \u2192 Settings \u2192 Integrations \u2192 Private Apps, grant: ${REQUIRED_SCOPES}, then try again.`;
  }
  return `HubSpot rejected this token (HTTP ${v.status}). Try regenerating the Private App token.`;
}
const MAX_BATCHES = 1000; // safety bound on the drive loop
const BATCH_SIZE = 100; // mirrors importEngine.ts's BATCH constant

/**
 * Drive runImportBatch to completion for one job. Exported (rather than
 * inlined in the route) so the cap-hit path is unit-testable with a small
 * maxBatches instead of looping the real MAX_BATCHES in a test.
 */
export async function driveImport(jobId: string, token: string, mode: ImportMode, maxBatches: number): Promise<void> {
  try {
    let more = true; let i = 0;
    while (more && i < maxBatches) { more = await runImportBatch(jobId, token, mode); i += 1; }
    if (more) {
      // Hit the safety cap rather than finishing naturally. Imports are
      // idempotent (matched by hubspotId), so re-running is safe — it just
      // reprocesses the records already imported before continuing further.
      const limit = maxBatches * BATCH_SIZE;
      await supabase.from('ImportJob').update({
        status: 'failed',
        error: `Reached the per-run limit of ${limit.toLocaleString()} records. Click "Import from HubSpot" again to continue — already-imported records won't be duplicated.`,
        finishedAt: new Date().toISOString(),
      }).eq('id', jobId);
    }
  } catch (err) {
    log.error(`[hubspot] import loop crashed: ${(err as Error).message}`);
    await supabase.from('ImportJob').update({ status: 'failed', error: (err as Error).message }).eq('id', jobId);
  }
}

/** Map the Supabase auth UUID (req.user.id) to the internal User.id (PK). */
async function resolveInternalUserId(authId: string | undefined): Promise<string | null> {
  if (!authId) return null;
  const { data } = await supabase.from('User').select('id').eq('authId', authId).single();
  return (data as { id?: string } | null)?.id ?? null;
}

// GET /connect → { connected }
router.get('/connect', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data } = await supabase.from('HubSpotConnection').select('id').eq('organizationId', orgId).maybeSingle();
  res.json({ connected: !!data });
});

// POST /connect → validate + store encrypted token
router.post('/connect', async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A HubSpot token is required' });
  const orgId = getOrgId(req);

  const validation = await new HubSpotClient(parsed.data.token).validateToken();
  if (!validation.ok) {
    log.warn(`[hubspot] token validation failed for org ${orgId}: HTTP ${validation.status} category=${validation.category ?? 'unknown'}`);
    return res.status(400).json({ error: tokenRejectionMessage(validation) });
  }

  const internalUserId = await resolveInternalUserId(req.user?.id);

  await supabase.from('HubSpotConnection').upsert({
    organizationId: orgId,
    authType: 'private_app',
    accessToken: encryptField(parsed.data.token),
    connectedBy: internalUserId,
    updatedAt: new Date().toISOString(),
  }, { onConflict: 'organizationId' });

  res.json({ connected: true });
});

// DELETE /connect
router.delete('/connect', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  await supabase.from('HubSpotConnection').delete().eq('organizationId', orgId);
  res.json({ connected: false });
});

// POST /import → create job + drive batches
router.post('/import', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  // 'fill' (default) never touches values that already exist locally.
  // 'refresh' lets HubSpot win for the fields it maps, so a client who fixes
  // data in HubSpot can re-run and have the corrections land.
  const mode = importSchema.safeParse(req.body).data?.mode ?? 'fill';
  const { data: conn } = await supabase
    .from('HubSpotConnection').select('accessToken').eq('organizationId', orgId).maybeSingle();
  if (!conn) return res.status(400).json({ error: 'Connect HubSpot before importing' });

  // I3: guard null decrypted token before doing any more work
  const token = decryptField((conn as { accessToken: string }).accessToken);
  if (!token) return res.status(500).json({ error: 'HubSpot connection could not be decrypted' });

  // I1: return existing in-flight job rather than spawning a second drive loop
  const { data: existing } = await supabase
    .from('ImportJob').select('id')
    .eq('organizationId', orgId).in('status', ['queued', 'running'])
    .maybeSingle();
  if (existing) return res.status(202).json({ jobId: (existing as { id: string }).id });

  const internalUserId = await resolveInternalUserId(req.user?.id);

  const { data: job } = await supabase.from('ImportJob').insert({
    organizationId: orgId, source: 'hubspot', status: 'running',
    objectCounts: {}, startedBy: internalUserId, startedAt: new Date().toISOString(),
  }).select('id').maybeSingle();
  const jobId = (job as { id: string }).id;

  // Respond immediately; drive the batches without blocking the response.
  res.status(202).json({ jobId });

  void driveImport(jobId, token, mode, MAX_BATCHES);
});

// GET /import/:id → status
router.get('/import/:id', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data } = await supabase
    .from('ImportJob').select('*').eq('id', req.params.id).eq('organizationId', orgId).maybeSingle();
  if (!data) return res.status(404).json({ error: 'Import job not found' });
  res.json(data);
});

// POST /import/:id/cancel
router.post('/import/:id/cancel', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  await supabase.from('ImportJob').update({ status: 'cancelled', finishedAt: new Date().toISOString() })
    .eq('id', req.params.id).eq('organizationId', orgId);
  res.json({ cancelled: true });
});

export default router;

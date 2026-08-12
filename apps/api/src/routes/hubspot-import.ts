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

// Object-read scopes let us import records; schema-read scopes let us discover the
// client's custom properties (GET /crm/v3/properties/{object}) so custom fields aren't
// silently dropped. Both sets are required for a lossless import.
//
// crm.objects.notes.read and crm.objects.emails.read are confirmed real
// HubSpot scope names (verified against HubSpot's community forum).
// crm.objects.calls.read / meetings.read / tasks.read follow the same
// naming convention but were NOT independently confirmed against HubSpot's
// authoritative scopes reference — if a client reports one of these three
// doesn't appear in their Private App scope picker, double-check against
// HubSpot's current docs before assuming the client's portal is at fault.
const REQUIRED_SCOPES =
  'crm.objects.companies.read, crm.objects.contacts.read, crm.objects.deals.read, '
  + 'crm.objects.notes.read, crm.objects.calls.read, crm.objects.meetings.read, crm.objects.emails.read, crm.objects.tasks.read, '
  + 'crm.schemas.companies.read, crm.schemas.contacts.read, crm.schemas.deals.read';

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
 * How long one request may spend importing before yielding back to the client.
 * vercel.json caps this function at maxDuration 300s; stop well short of that
 * so the response (and the job-state write inside the final batch) always
 * lands rather than being cut off mid-flight.
 *
 * 90s of headroom (not 60): the budget is only checked BETWEEN batches, so
 * the last batch started just under budget must fully complete inside the
 * headroom — including up to three HubSpot calls that can each burn capped
 * 429-backoff time (client.ts MAX_BACKOFF_MS) plus per-record DB round-trips.
 * Yielding one round earlier costs a ~1s continue round-trip; overrunning
 * costs a killed function and an error toast.
 */
const TIME_BUDGET_MS = 210_000;

/**
 * Drive runImportBatch for one job, bounded by BOTH a batch cap and a wall-clock
 * budget. Returns `{ more: true }` when the budget ran out with work remaining —
 * the caller is expected to issue another request to resume.
 *
 * Why this runs inside the request instead of as a background task: Vercel
 * freezes the serverless instance as soon as the HTTP response is sent, so a
 * fire-and-forget loop is killed mid-import and the job sits at 'running'
 * forever with no process working it. Cursor/currentObject are already
 * persisted per batch by runImportBatch, so resuming is just another call.
 *
 * Exported (rather than inlined in the route) so the cap-hit and budget paths
 * are unit-testable with small maxBatches/budgetMs values.
 */
export async function driveImport(
  jobId: string,
  token: string,
  mode: ImportMode,
  maxBatches: number,
  budgetMs: number = TIME_BUDGET_MS,
): Promise<{ more: boolean }> {
  const startedAt = Date.now();
  try {
    let more = true; let i = 0;
    while (more && i < maxBatches) {
      more = await runImportBatch(jobId, token, mode);
      i += 1;
      if (more && Date.now() - startedAt >= budgetMs) {
        // Out of time for this invocation, but the job is healthy and resumable
        // — leave its status alone and let the client continue it.
        return { more: true };
      }
    }
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
  // Cap-hit and crash paths both end the job (status already set above), so
  // there is nothing for the client to continue.
  return { more: false };
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

  // I1: an in-flight job is resumable rather than restartable — hand its id
  // back so the client continues it instead of starting a second one.
  const { data: existing } = await supabase
    .from('ImportJob').select('id')
    .eq('organizationId', orgId).in('status', ['queued', 'running'])
    .maybeSingle();
  if (existing) return res.status(202).json({ jobId: (existing as { id: string }).id, more: true });

  const internalUserId = await resolveInternalUserId(req.user?.id);

  const { data: job } = await supabase.from('ImportJob').insert({
    organizationId: orgId, source: 'hubspot', status: 'running',
    objectCounts: {}, startedBy: internalUserId, startedAt: new Date().toISOString(),
  }).select('id').maybeSingle();
  const jobId = (job as { id: string }).id;

  // Run the batches INSIDE this request — Vercel freezes the instance once the
  // response is sent, so a background loop would be killed mid-import and leave
  // the job stuck at 'running' forever. `more: true` means the time budget ran
  // out with work left; the client resumes via POST /import/:id/continue.
  const { more } = await driveImport(jobId, token, mode, MAX_BATCHES);
  res.status(202).json({ jobId, more });
});

// POST /import/:id/continue → resume a job whose previous request ran out of time
router.post('/import/:id/continue', async (req: Request, res: Response) => {
  const orgId = getOrgId(req);
  const { data: job } = await supabase
    .from('ImportJob').select('id, status')
    .eq('id', req.params.id).eq('organizationId', orgId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'Import job not found' });

  // Terminal (or cancelled) jobs have nothing left to do — tell the client to stop.
  if ((job as { status: string }).status !== 'running') return res.json({ more: false });

  const { data: conn } = await supabase
    .from('HubSpotConnection').select('accessToken').eq('organizationId', orgId).maybeSingle();
  if (!conn) return res.status(400).json({ error: 'Connect HubSpot before importing' });
  const token = decryptField((conn as { accessToken: string }).accessToken);
  if (!token) return res.status(500).json({ error: 'HubSpot connection could not be decrypted' });

  const mode = importSchema.safeParse(req.body).data?.mode ?? 'fill';
  const { more } = await driveImport(req.params.id, token, mode, MAX_BATCHES);
  res.json({ more });
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

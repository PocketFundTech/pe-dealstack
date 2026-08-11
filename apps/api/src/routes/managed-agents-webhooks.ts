import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getAnthropicClient } from '../services/ai/client.js';

const router = Router();

// Mounted with express.raw() ahead of the app's global express.json() —
// webhook signature verification needs the exact request bytes, and
// re-serializing through a JSON parser first would break the HMAC check.
router.post('/', async (req: Request, res: Response) => {
  const client = getAnthropicClient();
  let event;
  try {
    event = client.beta.webhooks.unwrap(req.body, { headers: req.headers as Record<string, string> });
  } catch (err) {
    log.warn('Managed Agents webhook: signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(400).json({ error: 'invalid signature' });
  }

  if (event.data.type !== 'session.status_terminated') {
    return res.status(204).end();
  }

  try {
    const session = await client.beta.sessions.retrieve(event.data.id);
    const organizationId = (session as any).metadata?.organizationId;
    const sessionError = (session as any).error;
    if (organizationId && sessionError) {
      const { data: org } = await supabase.from('Organization').select('settings').eq('id', organizationId).single();
      const settings = (org?.settings || {}) as Record<string, any>;
      settings.researchStatus = 'failed';
      settings.researchError = sessionError.message || 'Managed Agents session terminated with an error';
      await supabase.from('Organization').update({ settings }).eq('id', organizationId);
    }
  } catch (err) {
    log.error('Managed Agents webhook: failed to process session.status_terminated', {
      sessionId: event.data.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  res.status(204).end();
});

export default router;

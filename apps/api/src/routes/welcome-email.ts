// ─── Signup welcome email trigger ──────────────────────────────────
// Mounted at /api/public/welcome-email WITHOUT auth middleware — this
// fires immediately after supabase.auth.signUp() resolves client-side,
// before a session necessarily exists (email-confirmation-required
// signups have none yet). Never trusts a client-supplied email/name:
// looks the user up server-side by id and only sends for accounts
// created in the last 15 minutes, so the endpoint can't be replayed
// into a generic "email anyone repeatedly" vector even though ids are
// unguessable UUIDs.

import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendWelcomeEmail } from '../services/welcomeEmail.js';

const router = Router();

const MAX_ACCOUNT_AGE_MS = 15 * 60 * 1000;

router.post('/', async (req: Request, res: Response) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId : null;
  if (!userId) {
    return res.json({ sent: false });
  }

  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    log.warn('Welcome email: user lookup failed', { userId, error });
    return res.json({ sent: false });
  }

  const user = data.user;
  const createdAt = user.created_at ? new Date(user.created_at).getTime() : 0;
  if (!createdAt || Date.now() - createdAt > MAX_ACCOUNT_AGE_MS) {
    return res.json({ sent: false });
  }

  if (!user.email) {
    return res.json({ sent: false });
  }

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null;
  const sent = await sendWelcomeEmail({ to: user.email, name: fullName });
  res.json({ sent });
});

export default router;

// ─── Authenticated account-security emails ─────────────────────────
// Mounted at /api/account/security WITH authMiddleware only (no org/MFA
// gates — a user must be able to reach this even mid-MFA-lockout). Both
// endpoints read the acting user from req.user (attached by
// authMiddleware), never from the request body.

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { sendPasswordChangedEmail } from '../services/passwordChangedEmail.js';
import { sendNewDeviceLoginEmail } from '../services/newDeviceLoginEmail.js';

const router = Router();

// POST /api/account/security/password-changed
// Fired client-side right after supabase.auth.updateUser({ password }) (or
// the password-reset flow) resolves successfully. Always 200s — the caller
// treats this as fire-and-forget and never surfaces failures to the user.
router.post('/password-changed', async (req: Request, res: Response) => {
  const user = req.user;
  if (!user?.email) {
    return res.json({ sent: false });
  }

  const sent = await sendPasswordChangedEmail({ to: user.email, name: user.name ?? null });
  res.json({ sent });
});

// POST /api/account/security/login-check
// Fired client-side right after a successful password sign-in, before the
// MFA check. Computes a coarse device fingerprint (IP + user-agent) and
// compares it against KnownLoginDevice. A known device just refreshes
// lastSeenAt; an unknown one is recorded and triggers an alert email.
// Never throws — any DB error is logged and treated as "not sent".
router.post('/login-check', async (req: Request, res: Response) => {
  const user = req.user;
  if (!user?.id) {
    return res.json({ sent: false });
  }

  try {
    const fingerprintHash = createHash('sha256')
      .update(`${req.ip || ''}|${req.headers['user-agent'] || ''}`)
      .digest('hex');

    const { data: existing, error: lookupError } = await supabase
      .from('KnownLoginDevice')
      .select('id')
      .eq('userId', user.id)
      .eq('fingerprintHash', fingerprintHash)
      .maybeSingle();

    if (lookupError) {
      log.error('login-check: KnownLoginDevice lookup failed', { error: lookupError });
      return res.json({ sent: false });
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('KnownLoginDevice')
        .update({ lastSeenAt: new Date().toISOString() })
        .eq('id', existing.id);

      if (updateError) {
        log.error('login-check: KnownLoginDevice lastSeenAt update failed', { error: updateError });
      }
      return res.json({ sent: false, known: true });
    }

    const { error: insertError } = await supabase.from('KnownLoginDevice').insert({
      userId: user.id,
      fingerprintHash,
    });

    if (insertError) {
      log.error('login-check: KnownLoginDevice insert failed', { error: insertError });
      return res.json({ sent: false });
    }

    if (!user.email) {
      return res.json({ sent: false, known: false });
    }

    const sent = await sendNewDeviceLoginEmail({ to: user.email, name: user.name ?? null });
    res.json({ sent, known: false });
  } catch (err) {
    log.error('login-check threw', { err });
    res.json({ sent: false });
  }
});

export default router;

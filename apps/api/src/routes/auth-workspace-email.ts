// GET /api/auth/workspace-email — returns the Gmail address that owns the
// user's connected Google Workspace OAuth token. Surfaces the *actual*
// sender address back to the frontend so a user who signed in to Supabase
// with one account but connected Workspace under another sees the right
// From: line in the NDA send modal.
//
// Mounted under /api/auth with authMiddleware only — no orgMiddleware
// because:
//   1. We need to look up the internal User row (authId → id +
//      organizationId) ourselves anyway (the integration row is keyed on
//      the internal user id, not the Supabase auth id).
//   2. /api/auth/* sits behind the MFA bypass so users mid-MFA-enrollment
//      can still see their sender identity in the modal.
//
// Always 200 — `connected: false` (with optional error code) when the
// token is missing or the userinfo lookup fails, so the frontend can
// render a "Workspace not connected" warning instead of an error.
//
// The email + connected check resolves via the OAuth `userinfo` endpoint
// (userinfo.email scope), NOT Gmail — so the NDA import/Picker flow, which
// only needs Drive, isn't blocked on a missing gmail.send grant. Gmail send
// permission is checked separately at actual send time.

import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getProviderAccessToken } from '../integrations/_platform/tokenStore.js';
import { getUserInfo } from '../integrations/googleCalendar/client.js';

const router = Router();

interface InternalUserLookup {
  id: string;
  organizationId: string | null;
}

async function resolveInternalUser(
  authId: string,
): Promise<InternalUserLookup | null> {
  const { data } = await supabase
    .from('User')
    .select('id, organizationId')
    .eq('authId', authId)
    .single();
  return (data as InternalUserLookup | null) ?? null;
}

interface WorkspaceEmailResponse {
  email: string | null;
  connected: boolean;
  // True only for managed Google Workspace accounts (derived from the OAuth
  // `hd` hosted-domain claim). The NDA UI uses this to grey out the Google
  // Docs native eSignature actions, which require a Workspace account.
  isWorkspace?: boolean;
  error?: 'not_connected' | 'profile_fetch_failed' | 'user_not_provisioned';
}

router.get('/workspace-email', async (req: Request, res: Response) => {
  try {
    const authUser = req.user;
    if (!authUser?.id) {
      // authMiddleware should have already rejected, but be defensive.
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const internalUser = await resolveInternalUser(authUser.id);
    if (!internalUser?.organizationId) {
      // User hasn't been provisioned with an org yet (rare race during
      // first login) — return a soft 200 so the modal can render the
      // "not connected" path instead of erroring out.
      const body: WorkspaceEmailResponse = {
        email: null,
        connected: false,
        error: 'user_not_provisioned',
      };
      res.json(body);
      return;
    }

    const accessToken = await getProviderAccessToken({
      userId: internalUser.id,
      organizationId: internalUser.organizationId,
      providerId: 'google_calendar',
    });
    if (!accessToken) {
      const body: WorkspaceEmailResponse = {
        email: null,
        connected: false,
        error: 'not_connected',
      };
      res.json(body);
      return;
    }

    try {
      // Resolve the connected account's email via the OAuth `userinfo`
      // endpoint (needs only userinfo.email, which every connection grants)
      // rather than Gmail's profile (which needs gmail.send). The NDA *import*
      // flow only needs Drive access; gating "connected" on Gmail would block
      // import for users who haven't granted gmail.send yet. The send step
      // checks/triggers a gmail re-auth on its own when it actually needs it.
      const info = await getUserInfo(accessToken);
      const body: WorkspaceEmailResponse = {
        email: info.email,
        connected: true,
        // `hd` is present only for managed Workspace accounts — gates the
        // Google Docs eSignature actions in the NDA UI.
        isWorkspace: Boolean(info.hd),
      };
      res.json(body);
      return;
    } catch (err) {
      // Token exists but the userinfo lookup failed — a transient API blip or
      // a revoked token. Surface as 200 with `connected: false` + an error
      // code so the frontend renders the actionable "reconnect" CTA.
      log.warn('auth-workspace-email: getUserInfo failed', {
        userId: internalUser.id,
        message: err instanceof Error ? err.message : String(err),
      });
      const body: WorkspaceEmailResponse = {
        email: null,
        connected: false,
        error: 'profile_fetch_failed',
      };
      res.json(body);
      return;
    }
  } catch (err) {
    log.error('GET /api/auth/workspace-email error', err);
    res.status(500).json({ error: 'Failed to resolve workspace email' });
  }
});

export default router;

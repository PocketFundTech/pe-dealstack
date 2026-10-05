// ─── Integration errors the user can act on (QA #6) ────────────────
// Missing server config (Google OAuth keys, APP_URL, OAUTH_STATE_SECRET,
// DATA_ENCRYPTION_KEY) used to throw plain Errors, which the production
// error handler turns into "An unexpected error occurred". These are
// AppErrors, so their message reaches the user; the names of the missing
// variables go to the server log only.

import { AppError } from '../../middleware/errorHandler.js';
import { log } from '../../utils/logger.js';

export class IntegrationNotConfiguredError extends AppError {
  constructor(feature: string, missing: string[]) {
    super(`${feature} isn't set up on this server yet. Please contact your administrator.`, 503, 'INTEGRATION_NOT_CONFIGURED');
    log.error('Integration not configured — set the missing env vars in Vercel', { feature, missing });
  }
}

/** The provider answered, but not with success — say who and what. */
export class IntegrationUpstreamError extends AppError {
  constructor(message: string) {
    super(message, 502, 'INTEGRATION_UPSTREAM_ERROR');
  }
}

/**
 * Public base URL for OAuth redirect URIs. Falling back to localhost in
 * production sent Google a redirect URI it would never accept.
 */
export function appBaseUrl(): string {
  const base = process.env.APP_URL;
  if (base) return base.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') throw new IntegrationNotConfiguredError('Connecting accounts', ['APP_URL']);
  return 'http://localhost:3001';
}

export function googleClientCreds(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new IntegrationNotConfiguredError('Google sign-in', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  return { id, secret };
}

import { encrypt, decrypt } from '../../services/encryption.js';
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import type { Integration, IntegrationStatus, ProviderId } from './types.js';
import { refreshAccessToken as refreshGoogleToken } from '../googleCalendar/client.js';

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

export function encryptForStorage(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  return encrypt(value);
}

export function decryptFromStorage(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  return decrypt(value);
}

export async function saveTokens(params: {
  integrationId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}): Promise<void> {
  const { integrationId, accessToken, refreshToken, tokenExpiresAt } = params;
  const { error } = await supabase
    .from('Integration')
    .update({
      accessTokenEncrypted: encryptForStorage(accessToken),
      refreshTokenEncrypted: encryptForStorage(refreshToken),
      tokenExpiresAt: tokenExpiresAt,
      status: 'connected' as IntegrationStatus,
      consecutiveFailures: 0,
      lastSyncError: null,
      updatedAt: new Date().toISOString(),
    })
    .eq('id', integrationId);
  if (error) throw new Error(`tokenStore.saveTokens failed: ${error.message}`);
}

export async function getDecryptedTokens(
  integration: Integration
): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  return {
    accessToken: decryptFromStorage(integration.accessTokenEncrypted),
    refreshToken: decryptFromStorage(integration.refreshTokenEncrypted),
  };
}

/**
 * Resolve a fresh access token for `(userId, organizationId, providerId)`.
 * Refreshes via the provider's refresh-token endpoint if the stored token
 * is within the safety window of expiry. Currently only Google-family
 * providers (`google_calendar`, `gmail`) are supported — adding more is a
 * matter of mapping the providerId to its refresh function.
 *
 * Returns `null` when:
 *   - no connected integration exists for this user + provider, or
 *   - the stored token cannot be decrypted, or
 *   - the token is expired AND no refresh token is available, or
 *   - the refresh call fails (status flipped to 'error').
 *
 * Callers should map `null` to a 409 GOOGLE_NOT_CONNECTED-style error.
 */
export async function getProviderAccessToken(params: {
  userId: string;
  organizationId: string;
  providerId: ProviderId;
}): Promise<string | null> {
  const { userId, organizationId, providerId } = params;

  const { data, error } = await supabase
    .from('Integration')
    .select('*')
    .eq('userId', userId)
    .eq('organizationId', organizationId)
    .eq('provider', providerId)
    .eq('status', 'connected')
    .maybeSingle();
  if (error) {
    log.warn('getProviderAccessToken: lookup failed', {
      providerId, userId, message: error.message,
    });
    return null;
  }
  const integration = data as Integration | null;
  if (!integration) return null;

  const { accessToken, refreshToken } = await getDecryptedTokens(integration);
  if (!accessToken) return null;

  const expiresAt = integration.tokenExpiresAt
    ? Date.parse(integration.tokenExpiresAt)
    : 0;
  if (!expiresAt || expiresAt - Date.now() > TOKEN_REFRESH_SAFETY_MS) {
    return accessToken;
  }
  if (!refreshToken) {
    await markStatus(integration.id, 'error', 'no refresh token').catch(() => {});
    return null;
  }

  // Token refresh — providerId currently maps 1:1 to googleCalendar.client.
  // Gmail uses the same Google token endpoint, so the same refresh function
  // works for it too. When a non-Google provider is added, branch here.
  try {
    const refreshed = await refreshGoogleToken(refreshToken);
    await saveTokens({
      integrationId: integration.id,
      accessToken: refreshed.access_token,
      refreshToken,
      tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
    });
    return refreshed.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    log.warn('getProviderAccessToken: refresh failed', {
      providerId, integrationId: integration.id, msg,
    });
    await markStatus(integration.id, 'error', `refresh failed: ${msg}`).catch(() => {});
    return null;
  }
}

export async function markStatus(
  integrationId: string,
  status: IntegrationStatus,
  error?: string
): Promise<void> {
  const update: Record<string, unknown> = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (error !== undefined) update.lastSyncError = error;
  const { error: dbError } = await supabase
    .from('Integration')
    .update(update)
    .eq('id', integrationId);
  if (dbError) throw new Error(`tokenStore.markStatus failed: ${dbError.message}`);
}

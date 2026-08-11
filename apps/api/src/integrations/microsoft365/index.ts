import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import {
  encryptForStorage,
  decryptFromStorage,
  saveTokens,
} from '../_platform/tokenStore.js';
import { matchEmailAddressesToDeals } from '../_platform/matcher.js';
import { signState, verifyState } from '../_platform/oauth.js';
import type {
  Integration,
  IntegrationProvider,
  InitiateAuthResult,
  SyncOptions,
  SyncResult,
} from '../_platform/types.js';
import {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  refreshMicrosoftToken,
  getMicrosoftUserInfo,
} from '../microsoft/client.js';
import { MICROSOFT365_SCOPES, listEventsBetween } from './client.js';
import { calendarEventToIntegrationActivity, extractAttendeeEmails } from './mapper.js';

const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;
const WINDOW_BACK_DAYS = 30;
const WINDOW_FORWARD_DAYS = 30;

function redirectUri(): string {
  const base = process.env.APP_URL ?? 'http://localhost:3001';
  return `${base}/api/integrations/oauth/microsoft365/callback`;
}

async function ensureFreshAccessToken(integration: Integration): Promise<string> {
  const access = decryptFromStorage(integration.accessTokenEncrypted);
  const refresh = decryptFromStorage(integration.refreshTokenEncrypted);
  if (!access) throw new Error('Microsoft 365: no access token stored');

  const expiresAt = integration.tokenExpiresAt
    ? Date.parse(integration.tokenExpiresAt)
    : 0;
  if (!expiresAt || expiresAt - Date.now() > TOKEN_REFRESH_SAFETY_MS) return access;
  if (!refresh) throw new Error('Microsoft 365: access token expired and no refresh token stored');

  const refreshed = await refreshMicrosoftToken(refresh, MICROSOFT365_SCOPES);
  await saveTokens({
    integrationId: integration.id,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? refresh,
    tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  });
  return refreshed.access_token;
}

export const microsoft365Provider: IntegrationProvider = {
  id: 'microsoft365',
  displayName: 'Microsoft 365',
  scopes: MICROSOFT365_SCOPES,

  async initiateAuth(userId, organizationId): Promise<InitiateAuthResult> {
    const state = signState({ userId, organizationId, provider: 'microsoft365' });
    const authUrl = buildMicrosoftAuthUrl({
      redirectUri: redirectUri(),
      state,
      scopes: MICROSOFT365_SCOPES,
    });
    return { mode: 'oauth', authUrl, state };
  },

  async handleCallback({ code, state }): Promise<Integration> {
    const claims = verifyState(state);
    if (claims.provider !== 'microsoft365') {
      throw new Error('Microsoft 365 callback: state provider mismatch');
    }
    const tokens = await exchangeMicrosoftCode({
      code,
      redirectUri: redirectUri(),
      scopes: MICROSOFT365_SCOPES,
    });
    const userInfo = await getMicrosoftUserInfo(tokens.access_token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const { data: existing } = await supabase
      .from('Integration')
      .select('id')
      .eq('userId', claims.userId)
      .eq('provider', 'microsoft365')
      .maybeSingle();

    const baseRow = {
      organizationId: claims.organizationId,
      userId: claims.userId,
      provider: 'microsoft365' as const,
      status: 'connected' as const,
      externalAccountId: userInfo.id,
      externalAccountEmail: userInfo.email,
      accessTokenEncrypted: encryptForStorage(tokens.access_token),
      refreshTokenEncrypted: encryptForStorage(tokens.refresh_token ?? null),
      tokenExpiresAt: expiresAt,
      scopes: MICROSOFT365_SCOPES,
      settings: { displayName: userInfo.displayName ?? null },
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    if (existing?.id) {
      const { data, error } = await supabase
        .from('Integration').update(baseRow).eq('id', existing.id).select('*').single();
      if (error || !data) throw new Error(`Microsoft 365 callback failed: ${error?.message ?? 'no row'}`);
      return data as Integration;
    }
    const { data, error } = await supabase
      .from('Integration').insert({ ...baseRow, createdAt: now }).select('*').single();
    if (error || !data) throw new Error(`Microsoft 365 callback failed: ${error?.message ?? 'no row'}`);
    return data as Integration;
  },

  async sync(integration, _options: SyncOptions): Promise<SyncResult> {
    const accessToken = await ensureFreshAccessToken(integration);
    const now = Date.now();
    const timeMin = new Date(now - WINDOW_BACK_DAYS * 24 * 60 * 60 * 1000);
    const timeMax = new Date(now + WINDOW_FORWARD_DAYS * 24 * 60 * 60 * 1000);

    const events = await listEventsBetween(accessToken, timeMin, timeMax);
    let itemsMatched = 0;
    const errors: string[] = [];

    for (const event of events) {
      try {
        const emails = extractAttendeeEmails(event);
        const match = await matchEmailAddressesToDeals({
          organizationId: integration.organizationId,
          emails,
        });
        if (match.matchedDealIds.length === 0 && match.matchedContactIds.length === 0) {
          continue;
        }
        const row = calendarEventToIntegrationActivity({
          event,
          integrationId: integration.id,
          organizationId: integration.organizationId,
          userId: integration.userId,
          dealIds: match.matchedDealIds,
          contactIds: match.matchedContactIds,
        });
        const { error } = await supabase
          .from('IntegrationActivity')
          .upsert(row, { onConflict: 'integrationId,source,externalId' });
        if (error) {
          errors.push(`event ${event.id}: ${error.message}`);
        } else {
          itemsMatched++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        errors.push(`event ${event.id}: ${message}`);
        log.warn('microsoft365: per-event sync failed (continuing)', {
          eventId: event.id, message,
        });
      }
    }

    return { itemsSynced: events.length, itemsMatched, errors };
  },

  async handleWebhook(): Promise<void> {
    // Graph change-notification subscriptions are a future phase.
  },

  async disconnect(): Promise<void> {
    // Token revocation is best-effort; the route layer flips status to 'revoked'.
  },
};

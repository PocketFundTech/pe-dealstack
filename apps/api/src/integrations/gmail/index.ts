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
  GMAIL_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  getUserInfo,
  listMessagesSince,
  getMessage,
  getMessageRaw,
} from './client.js';
import {
  gmailMessageToIntegrationActivity,
  extractAddressEmails,
  extractBodyText,
  getHeaderMap,
  parseEmailAddress,
} from './mapper.js';
import { shouldSkipForAI } from './preFilter.js';

const DEFAULT_BACKFILL_DAYS = 90;
const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

// Cap LLM calls per cron tick so a freshly-connected flooded inbox cannot run up
// a huge bill on the first sync. Overridable per-integration via env.
const DEFAULT_CLASSIFIER_CAP_PER_RUN = Number(
  process.env.GMAIL_CLASSIFIER_CAP_PER_RUN ?? '200'
);

// Confidence threshold for auto-creating a Deal from a new sender.
// Per-org override lives in Organization.settings.autoCreateThreshold.
const DEFAULT_AUTO_CREATE_THRESHOLD = 0.85;

function redirectUri(): string {
  const base = process.env.APP_URL ?? 'http://localhost:3001';
  return `${base}/api/integrations/oauth/gmail/callback`;
}

async function getOrgContactEmails(organizationId: string): Promise<string[]> {
  const { data } = await supabase
    .from('Contact')
    .select('email')
    .eq('organizationId', organizationId);
  return Array.from(
    new Set(
      (data ?? [])
        .map((r: { email: string | null }) => r.email?.trim().toLowerCase())
        .filter((e): e is string => !!e)
    )
  );
}

interface AutoDealOrgSettings {
  autoDealEnabled: boolean;
  autoCreateThreshold: number;
  classifierCapPerRun: number;
  internalDomain: string | null;
}

// Reads the auto-deal toggle + tunables from Organization.settings JSONB.
// Default: OFF — classifier still runs (so dealRelevance gets stored for any
// future review-queue UI) but no deals are created or updated.
async function getAutoDealSettings(organizationId: string): Promise<AutoDealOrgSettings> {
  const { data } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', organizationId)
    .maybeSingle();
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const ad = (settings.autoDeal ?? {}) as Record<string, unknown>;
  return {
    autoDealEnabled: ad.enabled === true,
    autoCreateThreshold:
      typeof ad.createThreshold === 'number' && ad.createThreshold > 0 && ad.createThreshold <= 1
        ? (ad.createThreshold as number)
        : DEFAULT_AUTO_CREATE_THRESHOLD,
    classifierCapPerRun:
      typeof ad.classifierCapPerRun === 'number' && ad.classifierCapPerRun > 0
        ? (ad.classifierCapPerRun as number)
        : DEFAULT_CLASSIFIER_CAP_PER_RUN,
    internalDomain:
      typeof ad.internalDomain === 'string' && ad.internalDomain.length > 0
        ? (ad.internalDomain as string)
        : null,
  };
}

async function ensureFreshAccessToken(integration: Integration): Promise<string> {
  const access = decryptFromStorage(integration.accessTokenEncrypted);
  const refresh = decryptFromStorage(integration.refreshTokenEncrypted);
  if (!access) throw new Error('Gmail: no access token stored');

  const expiresAt = integration.tokenExpiresAt
    ? Date.parse(integration.tokenExpiresAt)
    : 0;
  const now = Date.now();
  if (!expiresAt || expiresAt - now > TOKEN_REFRESH_SAFETY_MS) {
    return access;
  }
  if (!refresh) {
    throw new Error('Gmail: access token expired and no refresh token stored');
  }
  const refreshed = await refreshAccessToken(refresh);
  await saveTokens({
    integrationId: integration.id,
    accessToken: refreshed.access_token,
    refreshToken: refresh,  // Google sometimes omits refresh_token on refresh; keep the original
    tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  });
  return refreshed.access_token;
}

export const gmailProvider: IntegrationProvider = {
  id: 'gmail',
  displayName: 'Gmail',
  scopes: GMAIL_SCOPES,

  async initiateAuth(userId, organizationId): Promise<InitiateAuthResult> {
    const state = signState({ userId, organizationId, provider: 'gmail' });
    const authUrl = buildAuthorizeUrl({
      redirectUri: redirectUri(),
      state,
      scopes: GMAIL_SCOPES,
    });
    return { mode: 'oauth', authUrl, state };
  },

  async handleCallback({ code, state }): Promise<Integration> {
    const claims = verifyState(state);
    if (claims.provider !== 'gmail') {
      throw new Error('Gmail callback: state provider mismatch');
    }
    const tokens = await exchangeCode(code, redirectUri());
    const userInfo = await getUserInfo(tokens.access_token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const { data: existing } = await supabase
      .from('Integration')
      .select('id')
      .eq('userId', claims.userId)
      .eq('provider', 'gmail')
      .maybeSingle();

    const baseRow = {
      organizationId: claims.organizationId,
      userId: claims.userId,
      provider: 'gmail' as const,
      status: 'connected' as const,
      externalAccountId: userInfo.email,
      externalAccountEmail: userInfo.email,
      accessTokenEncrypted: encryptForStorage(tokens.access_token),
      refreshTokenEncrypted: encryptForStorage(tokens.refresh_token ?? null),
      tokenExpiresAt: expiresAt,
      scopes: GMAIL_SCOPES,
      settings: { displayName: userInfo.name ?? null },
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    if (existing?.id) {
      const { data, error } = await supabase
        .from('Integration')
        .update(baseRow)
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error || !data) throw new Error(`Gmail callback failed: ${error?.message ?? 'no row'}`);
      return data as Integration;
    }
    const { data, error } = await supabase
      .from('Integration')
      .insert({ ...baseRow, createdAt: now })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Gmail callback failed: ${error?.message ?? 'no row'}`);
    return data as Integration;
  },

  async sync(integration, options: SyncOptions): Promise<SyncResult> {
    const accessToken = await ensureFreshAccessToken(integration);

    const knownEmails = await getOrgContactEmails(integration.organizationId);
    if (knownEmails.length === 0) {
      return { itemsSynced: 0, itemsMatched: 0, errors: [] };
    }

    const since =
      options.since ??
      (integration.lastSyncAt ? new Date(integration.lastSyncAt) : new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000));

    const headers = await listMessagesSince(accessToken, since, knownEmails);
    const autoDeal = await getAutoDealSettings(integration.organizationId);

    let itemsMatched = 0;
    let classifierBudget = autoDeal.classifierCapPerRun;
    const errors: string[] = [];

    for (const m of headers) {
      try {
        const meta = await getMessage(accessToken, m.id);
        const emails = extractAddressEmails(meta);
        const match = await matchEmailAddressesToDeals({
          organizationId: integration.organizationId,
          emails,
        });

        const hasMatch =
          match.matchedDealIds.length > 0 || match.matchedContactIds.length > 0;

        // Always store the activity row for any message touched by sync — it's
        // useful for the activity feed even when no deal/contact matches.
        // (Previous behaviour: skip storage when no match. New behaviour:
        // store with empty dealIds/contactIds so the classifier output and
        // any future deal links have a row to attach to.)
        const activityRow = gmailMessageToIntegrationActivity({
          message: meta,
          integrationId: integration.id,
          organizationId: integration.organizationId,
          userId: integration.userId,
          dealIds: match.matchedDealIds,
          contactIds: match.matchedContactIds,
        });
        const { data: activityInserted, error: activityErr } = await supabase
          .from('IntegrationActivity')
          .upsert(activityRow, {
            onConflict: 'integrationId,source,externalId',
          })
          .select('id')
          .single();
        if (activityErr) {
          errors.push(`message ${m.id}: ${activityErr.message}`);
          continue;
        }
        if (hasMatch) itemsMatched++;
        const integrationActivityId = (activityInserted?.id ?? null) as string | null;

        // From here on: AI work. Cheap pre-filter first, then per-tick budget.
        const headerMap = getHeaderMap(meta);
        const fromHeader = headerMap.From ?? headerMap.from ?? '';
        const parsedFrom = parseEmailAddress(fromHeader);
        const fromEmail = parsedFrom?.email ?? '';
        const fromName = parsedFrom?.name ?? null;
        const subject = headerMap.Subject ?? headerMap.subject ?? '(no subject)';
        const snippet = meta.snippet ?? '';

        const skip = shouldSkipForAI({
          subject,
          snippet,
          fromEmail,
          labels: meta.labelIds ?? [],
          headers: headerMap,
          orgInternalDomain: autoDeal.internalDomain,
        });
        if (skip.skip) {
          continue;
        }

        if (classifierBudget <= 0) {
          log.info('gmail: classifier budget exhausted for this run', {
            integrationId: integration.id,
          });
          continue;
        }
        classifierBudget--;

        // Fetch full body for classification + extraction.
        const full = await getMessageRaw(accessToken, m.id);
        const bodyText = extractBodyText(full);

        // Re-read headers from the full message (in case metadata header set
        // missed something).
        const fullHeaders = getHeaderMap(full);
        const toEmails = (fullHeaders.To ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const dateHeader = fullHeaders.Date ?? null;
        const occurredAt = meta.internalDate
          ? new Date(Number(meta.internalDate)).toISOString()
          : dateHeader ?? new Date().toISOString();

        const { runDealEmailClassifier } = await import('../../services/agents/dealEmailClassifier/index.js');
        const classification = await runDealEmailClassifier({
          subject,
          fromName,
          fromEmail,
          toEmails,
          date: dateHeader,
          bodyText,
        });

        // Persist classifier output regardless of decision — useful for tuning.
        if (classification && integrationActivityId) {
          await supabase
            .from('IntegrationActivity')
            .update({ dealRelevance: classification })
            .eq('id', integrationActivityId);
        }

        // Auto-deal toggle is OFF: classifier output is stored but we stop here.
        if (!autoDeal.autoDealEnabled) continue;
        if (!classification || !classification.isRelevant) continue;

        if (hasMatch && match.matchedDealIds.length > 0) {
          // Phase C: known deal — propose / apply field updates.
          for (const dealId of match.matchedDealIds) {
            try {
              const { autoUpdateDealFromEmail } = await import('./autoUpdateDeal.js');
              await autoUpdateDealFromEmail({
                dealId,
                organizationId: integration.organizationId,
                email: {
                  subject,
                  from: fromHeader,
                  date: occurredAt,
                  bodyText,
                  messageId: fullHeaders['Message-ID'] ?? fullHeaders['Message-Id'] ?? null,
                  threadId: full.threadId ?? null,
                },
                integrationActivityId,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : 'unknown error';
              errors.push(`message ${m.id} update(deal=${dealId}): ${message}`);
              log.warn('gmail: autoUpdate failed (continuing)', { messageId: m.id, dealId, message });
            }
          }
        } else if (classification.confidence >= autoDeal.autoCreateThreshold) {
          // Phase B: new sender + high confidence → create a Deal.
          try {
            const { createDealFromEmail } = await import('./autoCreateDeal.js');
            const result = await createDealFromEmail({
              organizationId: integration.organizationId,
              userId: integration.userId,
              source: 'ai_email_gmail',
              email: {
                subject,
                from: fromHeader,
                date: new Date(occurredAt),
                bodyText,
              },
              threadId: full.threadId ?? null,
              messageId: fullHeaders['Message-ID'] ?? fullHeaders['Message-Id'] ?? null,
              integrationActivityId,
            });
            // If a deal was created, backfill the activity row with the dealId
            // so the activity feed shows the link immediately.
            if (result.created && result.dealId && integrationActivityId) {
              await supabase
                .from('IntegrationActivity')
                .update({ dealIds: [result.dealId] })
                .eq('id', integrationActivityId);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'unknown error';
            errors.push(`message ${m.id} create: ${message}`);
            log.warn('gmail: autoCreate failed (continuing)', { messageId: m.id, message });
          }
        }
        // else: confidence below threshold for create → store classifier output
        // only (already done above). The future review-queue UI will surface it.
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        errors.push(`message ${m.id}: ${message}`);
        log.warn('gmail: per-message sync failed (continuing)', { messageId: m.id, message });
      }
    }

    return { itemsSynced: headers.length, itemsMatched, errors };
  },

  async handleWebhook(): Promise<void> {
    // Gmail Pub/Sub push is a future phase. No-op if anyone POSTs.
  },

  async disconnect(): Promise<void> {
    // Token revocation via https://oauth2.googleapis.com/revoke is best-effort
    // and not required for the user-facing disconnect flow. Route layer flips
    // status to 'revoked' regardless.
  },
};

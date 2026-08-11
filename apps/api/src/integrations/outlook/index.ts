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
import { OUTLOOK_SCOPES, listMessagesSince, getMessageWithBody, listAttachments } from './client.js';
import {
  outlookMessageToIntegrationActivity,
  extractAddressEmails,
  extractBodyText,
} from './mapper.js';
import { shouldSkipForAI } from './preFilter.js';
import { uploadEmailAttachmentsToDeal } from './attachments.js';

const DEFAULT_BACKFILL_DAYS = 90;
const TOKEN_REFRESH_SAFETY_MS = 60 * 1000;

// Cap classifier (LLM) calls per sync so a freshly-connected busy mailbox
// can't run up a large bill on the first backfill.
const DEFAULT_CLASSIFIER_CAP_PER_RUN = Number(
  process.env.OUTLOOK_CLASSIFIER_CAP_PER_RUN ?? '200'
);

function redirectUri(): string {
  const base = process.env.APP_URL ?? 'http://localhost:3001';
  // The callback route resolves the provider from the URL segment, so each
  // provider uses its own path (mirrors gmail's /oauth/gmail/callback). Both
  // this and microsoft365's path must be registered as redirect URIs on the
  // single shared Azure app.
  return `${base}/api/integrations/oauth/outlook/callback`;
}

async function ensureFreshAccessToken(integration: Integration): Promise<string> {
  const access = decryptFromStorage(integration.accessTokenEncrypted);
  const refresh = decryptFromStorage(integration.refreshTokenEncrypted);
  if (!access) throw new Error('Outlook: no access token stored');

  const expiresAt = integration.tokenExpiresAt
    ? Date.parse(integration.tokenExpiresAt)
    : 0;
  if (!expiresAt || expiresAt - Date.now() > TOKEN_REFRESH_SAFETY_MS) return access;
  if (!refresh) throw new Error('Outlook: access token expired and no refresh token stored');

  const refreshed = await refreshMicrosoftToken(refresh, OUTLOOK_SCOPES);
  await saveTokens({
    integrationId: integration.id,
    accessToken: refreshed.access_token,
    // Microsoft may rotate the refresh token; keep the new one if present.
    refreshToken: refreshed.refresh_token ?? refresh,
    tokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  });
  return refreshed.access_token;
}

export const outlookProvider: IntegrationProvider = {
  id: 'outlook',
  displayName: 'Outlook',
  scopes: OUTLOOK_SCOPES,

  async initiateAuth(userId, organizationId): Promise<InitiateAuthResult> {
    const state = signState({ userId, organizationId, provider: 'outlook' });
    const authUrl = buildMicrosoftAuthUrl({
      redirectUri: redirectUri(),
      state,
      scopes: OUTLOOK_SCOPES,
    });
    return { mode: 'oauth', authUrl, state };
  },

  async handleCallback({ code, state }): Promise<Integration> {
    const claims = verifyState(state);
    if (claims.provider !== 'outlook') {
      throw new Error('Outlook callback: state provider mismatch');
    }
    const tokens = await exchangeMicrosoftCode({
      code,
      redirectUri: redirectUri(),
      scopes: OUTLOOK_SCOPES,
    });
    const userInfo = await getMicrosoftUserInfo(tokens.access_token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const { data: existing } = await supabase
      .from('Integration')
      .select('id')
      .eq('userId', claims.userId)
      .eq('provider', 'outlook')
      .maybeSingle();

    const baseRow = {
      organizationId: claims.organizationId,
      userId: claims.userId,
      provider: 'outlook' as const,
      status: 'connected' as const,
      externalAccountId: userInfo.id,
      externalAccountEmail: userInfo.email,
      accessTokenEncrypted: encryptForStorage(tokens.access_token),
      refreshTokenEncrypted: encryptForStorage(tokens.refresh_token ?? null),
      tokenExpiresAt: expiresAt,
      scopes: OUTLOOK_SCOPES,
      settings: { displayName: userInfo.displayName ?? null },
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    if (existing?.id) {
      const { data, error } = await supabase
        .from('Integration').update(baseRow).eq('id', existing.id).select('*').single();
      if (error || !data) throw new Error(`Outlook callback failed: ${error?.message ?? 'no row'}`);
      return data as Integration;
    }
    const { data, error } = await supabase
      .from('Integration').insert({ ...baseRow, createdAt: now }).select('*').single();
    if (error || !data) throw new Error(`Outlook callback failed: ${error?.message ?? 'no row'}`);
    return data as Integration;
  },

  async sync(integration, options: SyncOptions): Promise<SyncResult> {
    const accessToken = await ensureFreshAccessToken(integration);

    const since =
      options.since ??
      (integration.lastSyncAt
        ? new Date(integration.lastSyncAt)
        : new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000));

    const messages = await listMessagesSince(accessToken, since);
    let itemsMatched = 0;
    let classifierBudget = DEFAULT_CLASSIFIER_CAP_PER_RUN;
    const errors: string[] = [];

    for (const message of messages) {
      try {
        // 1. Drop clearly-automated mail (no-reply/bulk) before any LLM spend.
        //    Conservative — never matches a real person's deal email.
        if (shouldSkipForAI(message)) continue;
        if (classifierBudget <= 0) break;
        classifierBudget--;

        // 2. Fetch the body and classify: is this a DEAL email?
        const full = await getMessageWithBody(accessToken, message.id);
        const fromEmail =
          full.from?.emailAddress?.address?.toLowerCase() ??
          full.sender?.emailAddress?.address?.toLowerCase() ?? '';
        const fromName =
          full.from?.emailAddress?.name ?? full.sender?.emailAddress?.name ?? null;
        const toEmails = (full.toRecipients ?? [])
          .map((r) => r.emailAddress?.address ?? '')
          .filter(Boolean);
        const bodyText = extractBodyText(full);
        const occurredAt = full.receivedDateTime ? new Date(full.receivedDateTime) : new Date();

        const { runDealEmailClassifier } = await import('../../services/agents/dealEmailClassifier/index.js');
        const classification = await runDealEmailClassifier({
          subject: full.subject || '(no subject)',
          fromName,
          fromEmail,
          toEmails,
          date: full.receivedDateTime ?? null,
          bodyText,
        });

        // 3. Only deal emails go further. Non-deal mail is ignored (not logged).
        if (!classification || !classification.isRelevant) continue;

        // 4. Route by the COMPANY the email is about — NOT by who sent it.
        //    createDealFromOutlookEmail extracts the company, then either
        //    attaches to the existing deal for that company or creates a new
        //    one. So one banker emailing about many companies yields one deal
        //    per company (no funneling onto whatever deal they're already on).
        let dealIds: string[] = [];
        let contactIds: string[] = [];
        const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

        const { createDealFromOutlookEmail, ensureContactOnDeal } = await import('./autoCreateDeal.js');
        const dealResult = await createDealFromOutlookEmail({
          organizationId: integration.organizationId,
          userId: integration.userId,
          email: {
            subject: full.subject || '(no subject)',
            from: fromHeader,
            date: occurredAt,
            bodyText,
          },
          messageId: full.internetMessageId ?? message.id,
          conversationId: full.conversationId ?? null,
        });

        if (dealResult.dealId) {
          dealIds = [dealResult.dealId];
          const contactId = await ensureContactOnDeal({
            organizationId: integration.organizationId,
            dealId: dealResult.dealId,
            email: fromEmail,
            name: fromName,
          });
          if (contactId) contactIds = [contactId];
        } else {
          // No company could be extracted (e.g. a vague reply) — fall back to
          // the sender's existing contact/deal links so the email still lands
          // somewhere sensible rather than being orphaned.
          const participantEmails = extractAddressEmails(full);
          const match = await matchEmailAddressesToDeals({
            organizationId: integration.organizationId,
            emails: participantEmails,
          });
          dealIds = match.matchedDealIds;
          contactIds = match.matchedContactIds;
        }

        // 6. Log the email as activity (linked to the deal/contact) + classifier output.
        const row = outlookMessageToIntegrationActivity({
          message: full,
          integrationId: integration.id,
          organizationId: integration.organizationId,
          userId: integration.userId,
          dealIds,
          contactIds,
        });
        const { data: inserted, error: activityErr } = await supabase
          .from('IntegrationActivity')
          .upsert(row, { onConflict: 'integrationId,source,externalId' })
          .select('id')
          .single();
        if (activityErr) {
          errors.push(`message ${message.id}: ${activityErr.message}`);
          continue;
        }
        if (inserted?.id) {
          await supabase
            .from('IntegrationActivity')
            .update({ dealRelevance: classification })
            .eq('id', inserted.id);
        }

        // 7. If the email carried file attachments and we have a deal, save them
        //    into that deal's Documents (Data Room). Stored only — the user runs
        //    "Extract Financials" on demand. Best-effort: never fails the sync.
        if (full.hasAttachments && dealIds.length > 0) {
          try {
            const files = await listAttachments(accessToken, message.id);
            if (files.length > 0) {
              await uploadEmailAttachmentsToDeal({
                organizationId: integration.organizationId,
                dealId: dealIds[0],
                userId: integration.userId,
                attachments: files,
              });
            }
          } catch (attErr) {
            log.warn('outlook: attachment sync failed (continuing)', {
              messageId: message.id, err: (attErr as Error).message,
            });
          }
        }

        itemsMatched++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        errors.push(`message ${message.id}: ${msg}`);
        log.warn('outlook: per-message sync failed (continuing)', {
          messageId: message.id, message: msg,
        });
      }
    }

    return { itemsSynced: messages.length, itemsMatched, errors };
  },

  async handleWebhook(): Promise<void> {
    // Graph change-notification subscriptions are a future phase.
  },

  async disconnect(): Promise<void> {
    // Token revocation is best-effort; the route layer flips status to 'revoked'.
  },
};

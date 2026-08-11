import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import {
  encryptForStorage,
  decryptFromStorage,
} from '../_platform/tokenStore.js';
import { matchEmailAddressesToDeals } from '../_platform/matcher.js';
import type {
  Integration,
  IntegrationProvider,
  InitiateAuthResult,
  SyncOptions,
  SyncResult,
} from '../_platform/types.js';
import { validateKey, listNotesSince, getNoteWithTranscript } from './client.js';
import { granolaNoteToIntegrationActivity } from './mapper.js';

const DEFAULT_BACKFILL_DAYS = 30;

async function findExistingIntegrationId(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Integration')
    .select('id')
    .eq('userId', userId)
    .eq('provider', 'granola')
    .maybeSingle();
  return data?.id ?? null;
}

export const granolaProvider: IntegrationProvider = {
  id: 'granola',
  displayName: 'Granola',
  scopes: [],

  async initiateAuth(): Promise<InitiateAuthResult> {
    return {
      mode: 'api_key',
      instructions: {
        title: 'Connect Granola',
        body:
          'Granola requires a Business or Enterprise plan to issue API keys. ' +
          'Generate one in the Granola desktop app under Settings → Connectors → API keys, ' +
          'then paste it below.',
        helpUrl: 'https://docs.granola.ai/help-center/sharing/integrations/personal-api',
        placeholder: 'grn_…',
      },
    };
  },

  async handleCallback(): Promise<Integration> {
    throw new Error('Granola uses api_key auth, not OAuth callback');
  },

  async connectWithApiKey(params): Promise<Integration> {
    const userInfo = await validateKey(params.apiKey);
    const now = new Date().toISOString();
    const existingId = await findExistingIntegrationId(params.userId);

    const baseRow = {
      organizationId: params.organizationId,
      userId: params.userId,
      provider: 'granola' as const,
      status: 'connected' as const,
      externalAccountId: userInfo.email,
      externalAccountEmail: userInfo.email,
      accessTokenEncrypted: encryptForStorage(params.apiKey),
      refreshTokenEncrypted: null,
      tokenExpiresAt: null,
      scopes: [],
      settings: { plan: userInfo.plan, displayName: userInfo.name },
      lastSyncAt: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      updatedAt: now,
    };

    if (existingId) {
      const { data, error } = await supabase
        .from('Integration')
        .update(baseRow)
        .eq('id', existingId)
        .select('*')
        .single();
      if (error || !data) throw new Error(`Granola connect failed: ${error?.message ?? 'no row'}`);
      return data as Integration;
    }
    const { data, error } = await supabase
      .from('Integration')
      .insert({ ...baseRow, createdAt: now })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Granola connect failed: ${error?.message ?? 'no row'}`);
    return data as Integration;
  },

  async sync(integration, options: SyncOptions): Promise<SyncResult> {
    const apiKey = decryptFromStorage(integration.accessTokenEncrypted);
    if (!apiKey) throw new Error('Granola: no API key stored');

    const since =
      options.since?.toISOString() ??
      integration.lastSyncAt ??
      new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const notes = await listNotesSince(apiKey, since);
    let itemsMatched = 0;
    const errors: string[] = [];

    for (const note of notes) {
      try {
        const attendeeEmails = note.attendees
          .map(a => a.email)
          .filter((e): e is string => !!e);
        const match = await matchEmailAddressesToDeals({
          organizationId: integration.organizationId,
          emails: attendeeEmails,
        });
        if (match.matchedDealIds.length === 0 && match.matchedContactIds.length === 0) {
          continue;
        }

        const full = await getNoteWithTranscript(apiKey, note.id);
        const row = await granolaNoteToIntegrationActivity({
          note: full,
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
          errors.push(`note ${note.id}: ${error.message}`);
        } else {
          itemsMatched++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        errors.push(`note ${note.id}: ${message}`);
        log.warn('granola: per-note sync failed (continuing)', {
          noteId: note.id, message,
        });
      }
    }

    return { itemsSynced: notes.length, itemsMatched, errors };
  },

  async handleWebhook(): Promise<void> {
    // Granola does not send webhooks. No-op if anyone POSTs anyway.
  },

  async disconnect(): Promise<void> {
    // Personal API keys can only be revoked from the Granola desktop app.
    // Route layer handles status='revoked' on our Integration row.
  },
};

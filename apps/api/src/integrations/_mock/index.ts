import { supabase } from '../../supabase.js';
import { saveTokens } from '../_platform/tokenStore.js';
import type {
  Integration,
  IntegrationProvider,
  InitiateAuthResult,
  SyncOptions,
  SyncResult,
} from '../_platform/types.js';

export const mockProvider: IntegrationProvider = {
  id: '_mock',
  displayName: 'Mock Provider (test only)',
  scopes: ['mock.read'],

  async initiateAuth(): Promise<InitiateAuthResult> {
    return { mode: 'oauth', authUrl: 'https://mock.example.com/auth', state: 'mock-state' };
  },

  async handleCallback(): Promise<Integration> {
    throw new Error('Mock provider callback is exercised by tests via direct DB writes');
  },

  async sync(integration: Integration, _options: SyncOptions): Promise<SyncResult> {
    await saveTokens({
      integrationId: integration.id,
      accessToken: 'mock-access-token-refreshed',
      refreshToken: integration.refreshTokenEncrypted ? 'mock-refresh' : null,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    return { itemsSynced: 1, itemsMatched: 0, errors: [] };
  },

  async handleWebhook(): Promise<void> {
    // No-op — webhook tests insert IntegrationEvent rows directly.
  },

  async disconnect(integration: Integration): Promise<void> {
    await supabase
      .from('Integration')
      .update({ status: 'revoked' })
      .eq('id', integration.id);
  },
};

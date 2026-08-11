// Phase 0 — shared integration platform types.
// Every provider (granola, gmail, etc.) implements IntegrationProvider.

export type ProviderId =
  | 'granola'
  | 'gmail'
  | 'google_calendar'
  | 'outlook'
  | 'microsoft365'
  | 'fireflies'
  | 'otter'
  | '_mock';

export type IntegrationStatus =
  | 'connected'
  | 'token_expired'
  | 'revoked'
  | 'error';

export interface Integration {
  id: string;
  organizationId: string;
  userId: string;
  provider: ProviderId;
  status: IntegrationStatus;
  externalAccountId: string | null;
  externalAccountEmail: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  settings: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncOptions {
  since?: Date;
  backfill?: boolean;
}

export interface SyncResult {
  itemsSynced: number;
  itemsMatched: number;
  errors: string[];
  newCursor?: string;
}

export type AuthMode = 'oauth' | 'api_key';

export interface InitiateAuthResult {
  mode: AuthMode;
  authUrl?: string;                         // present when mode === 'oauth'
  state?: string;                           // OAuth-state token (oauth mode)
  instructions?: {                          // present when mode === 'api_key'
    title: string;
    body: string;
    helpUrl?: string;
    placeholder?: string;
  };
}

export interface IntegrationProvider {
  id: ProviderId;
  displayName: string;
  scopes: string[];
  initiateAuth(userId: string, organizationId: string): Promise<InitiateAuthResult>;
  handleCallback(params: { code: string; state: string }): Promise<Integration>;
  /** API-key-paste mode: user submitted a long-lived bearer token directly. */
  connectWithApiKey?(params: {
    userId: string;
    organizationId: string;
    apiKey: string;
  }): Promise<Integration>;
  sync(integration: Integration, options: SyncOptions): Promise<SyncResult>;
  handleWebhook(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer
  ): Promise<void>;
  disconnect(integration: Integration): Promise<void>;
}

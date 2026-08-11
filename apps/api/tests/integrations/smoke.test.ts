import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  process.env.DATA_ENCRYPTION_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
  vi.resetModules();
});

describe('Phase 0 smoke', () => {
  it('registers, fetches, and exercises sync()', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    vi.doMock('../../src/supabase.js', () => ({
      supabase: { from: vi.fn(() => ({ update })) },
    }));

    const {
      _resetRegistryForTests, registerProvider, getProvider, isProviderRegistered,
    } = await import('../../src/integrations/_platform/registry.js');
    _resetRegistryForTests();

    const { mockProvider } = await import('../../src/integrations/_mock/index.js');
    registerProvider(mockProvider);

    expect(isProviderRegistered('_mock')).toBe(true);
    const provider = getProvider('_mock');
    expect(provider.id).toBe('_mock');

    const integration = {
      id: 'int-1', organizationId: 'org-1', userId: 'u-1', provider: '_mock',
      status: 'connected', accessTokenEncrypted: null, refreshTokenEncrypted: null,
      tokenExpiresAt: null, scopes: [], settings: {}, lastSyncAt: null,
      lastSyncError: null, consecutiveFailures: 0,
      externalAccountId: null, externalAccountEmail: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any;

    const result = await provider.sync(integration, {});
    expect(result.itemsSynced).toBe(1);
    expect(update).toHaveBeenCalled();
  });
});

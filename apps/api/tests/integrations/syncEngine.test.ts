import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

describe('syncEngine.syncIntegration', () => {
  it('returns success result and resets failures on a healthy sync', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('../../src/supabase.js', () => ({
      supabase: { from: vi.fn(() => ({ update, insert })) },
    }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();
    const sync = vi.fn().mockResolvedValue({ itemsSynced: 3, itemsMatched: 1, errors: [] });
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync,
      handleWebhook: vi.fn(), disconnect: vi.fn(),
    } as any);

    const { syncIntegration } = await import('../../src/integrations/_platform/syncEngine.js');
    const integration = {
      id: 'int-1', provider: '_mock', status: 'connected', consecutiveFailures: 0,
    } as any;
    const result = await syncIntegration(integration);
    expect(result.itemsSynced).toBe(3);
    expect(sync).toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('increments consecutiveFailures and emits notification at 3 failures', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('../../src/supabase.js', () => ({
      supabase: { from: vi.fn(() => ({ update, insert })) },
    }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();
    const sync = vi.fn().mockRejectedValue(new Error('boom'));
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync,
      handleWebhook: vi.fn(), disconnect: vi.fn(),
    } as any);

    const { syncIntegration } = await import('../../src/integrations/_platform/syncEngine.js');
    const integration = {
      id: 'int-1', provider: '_mock', status: 'connected',
      consecutiveFailures: 2, userId: 'u-1',
    } as any;
    await expect(syncIntegration(integration)).rejects.toThrow('boom');
    expect(insert).toHaveBeenCalled();  // 3rd failure inserts notification
  });
});

describe('syncEngine.syncAll', () => {
  it('runs each integration with a timeout and isolates failures', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({
        data: [
          { id: 'fast-1',  provider: '_mock', status: 'connected', consecutiveFailures: 0, userId: 'u-1' },
          { id: 'slow-2',  provider: '_mock', status: 'connected', consecutiveFailures: 0, userId: 'u-1' },
          { id: 'fast-3',  provider: '_mock', status: 'connected', consecutiveFailures: 0, userId: 'u-1' },
        ],
        error: null,
      }),
    });
    vi.doMock('../../src/supabase.js', () => ({
      supabase: { from: vi.fn(() => ({ update, insert, select })) },
    }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();

    const sync = vi.fn().mockImplementation(async (integration: any) => {
      if (integration.id === 'slow-2') {
        await new Promise((r) => setTimeout(r, 200));  // exceeds the 50ms test timeout
      }
      return { itemsSynced: 1, itemsMatched: 0, errors: [] };
    });
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync,
      handleWebhook: vi.fn(), disconnect: vi.fn(),
    } as any);

    const { syncAll } = await import('../../src/integrations/_platform/syncEngine.js');
    const result = await syncAll({ timeoutMs: 50, concurrency: 3 });

    expect(result.ranFor).toBe(3);
    expect(result.succeeded).toBe(2);  // fast-1 and fast-3
    expect(result.failed).toBe(1);     // slow-2 timed out
  });

  it('honors the concurrency limit (no more than N in flight)', async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({
        data: Array.from({ length: 6 }, (_, i) => ({
          id: `int-${i}`, provider: '_mock', status: 'connected',
          consecutiveFailures: 0, userId: 'u-1',
        })),
        error: null,
      }),
    });
    vi.doMock('../../src/supabase.js', () => ({
      supabase: { from: vi.fn(() => ({ update, insert, select })) },
    }));

    const { _resetRegistryForTests, registerProvider } = await import(
      '../../src/integrations/_platform/registry.js'
    );
    _resetRegistryForTests();

    let inFlight = 0;
    let maxInFlight = 0;
    const sync = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { itemsSynced: 1, itemsMatched: 0, errors: [] };
    });
    registerProvider({
      id: '_mock', displayName: 'M', scopes: [],
      initiateAuth: vi.fn(), handleCallback: vi.fn(), sync,
      handleWebhook: vi.fn(), disconnect: vi.fn(),
    } as any);

    const { syncAll } = await import('../../src/integrations/_platform/syncEngine.js');
    await syncAll({ concurrency: 2, timeoutMs: 1000 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);  // must have actually used concurrency
  });
});

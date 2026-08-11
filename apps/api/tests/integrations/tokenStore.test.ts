import { describe, it, expect, vi, beforeEach } from 'vitest';

const TEST_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

beforeEach(() => {
  process.env.DATA_ENCRYPTION_KEY = TEST_KEY;
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
  vi.doMock('../../src/supabase.js', () => ({
    supabase: { from: vi.fn() },
  }));
});

describe('tokenStore', () => {
  it('encrypts and round-trips an access token', async () => {
    const { encryptForStorage, decryptFromStorage } = await import(
      '../../src/integrations/_platform/tokenStore.js'
    );
    const original = 'ya29.a0AfH6SMB-pretend-google-token';
    const encrypted = encryptForStorage(original);
    expect(encrypted).not.toBe(original);
    expect(decryptFromStorage(encrypted)).toBe(original);
  });

  it('returns null for null inputs (optional refresh token)', async () => {
    const { encryptForStorage, decryptFromStorage } = await import(
      '../../src/integrations/_platform/tokenStore.js'
    );
    expect(encryptForStorage(null)).toBeNull();
    expect(decryptFromStorage(null)).toBeNull();
  });
});

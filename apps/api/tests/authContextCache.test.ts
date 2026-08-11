import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedUserContext,
  setCachedUserContext,
  invalidateUserContext,
  getCachedOrgMfa,
  setCachedOrgMfa,
  invalidateOrgMfa,
} from '../src/middleware/authContextCache.js';

describe('authContextCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('user context', () => {
    it('returns undefined for an unknown key', () => {
      expect(getCachedUserContext('missing-auth-id')).toBeUndefined();
    });

    it('stores and returns a value within the TTL', () => {
      setCachedUserContext('auth-1', { userId: 'u1', organizationId: 'org1', role: 'ADMIN' });
      expect(getCachedUserContext('auth-1')).toEqual({ userId: 'u1', organizationId: 'org1', role: 'ADMIN' });
    });

    it('expires after the 30s TTL', () => {
      setCachedUserContext('auth-2', { userId: 'u2', organizationId: 'org2', role: 'MEMBER' });
      vi.advanceTimersByTime(29_000);
      expect(getCachedUserContext('auth-2')).toBeDefined();
      vi.advanceTimersByTime(2_000); // now > 30s
      expect(getCachedUserContext('auth-2')).toBeUndefined();
    });

    it('invalidate drops the entry immediately', () => {
      setCachedUserContext('auth-3', { userId: 'u3', organizationId: 'org3', role: 'ADMIN' });
      invalidateUserContext('auth-3');
      expect(getCachedUserContext('auth-3')).toBeUndefined();
    });
  });

  describe('org MFA', () => {
    it('caches boolean values including false', () => {
      setCachedOrgMfa('org-a', false);
      expect(getCachedOrgMfa('org-a')).toBe(false); // must be false, not undefined
      setCachedOrgMfa('org-b', true);
      expect(getCachedOrgMfa('org-b')).toBe(true);
    });

    it('expires after the TTL', () => {
      setCachedOrgMfa('org-c', true);
      vi.advanceTimersByTime(31_000);
      expect(getCachedOrgMfa('org-c')).toBeUndefined();
    });

    it('invalidate drops the entry immediately', () => {
      setCachedOrgMfa('org-d', true);
      invalidateOrgMfa('org-d');
      expect(getCachedOrgMfa('org-d')).toBeUndefined();
    });
  });
});

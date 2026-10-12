/**
 * Regression: the user whose signup causes a NEW organization to be created
 * must become that org's ADMIN (previously MEMBER, so founders could not
 * create API keys/webhooks or manage the team). Users created without a new
 * org keep the role they were given (invitees carry their invitation role).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({ mockSupabase: { from: vi.fn() } }));
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findOrCreateUser } from '../src/services/userService.js';

let userInserts: any[];
let existingUser: any;

beforeEach(() => {
  userInserts = [];
  existingUser = null;
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'Organization') {
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: 'org-new' }, error: null }) }),
        }),
        update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
      };
    }
    // User
    return {
      select: () => ({
        eq: () => ({
          single: async () =>
            existingUser
              ? { data: existingUser, error: null }
              : { data: null, error: { code: 'PGRST116' } },
        }),
      }),
      insert: (row: any) => {
        userInserts.push(row);
        return {
          select: () => ({ single: async () => ({ data: { id: 'u1', ...row }, error: null }) }),
        };
      },
    };
  });
});

const base = { id: 'auth-1', email: 'f@firm.com', name: 'F' };

describe('findOrCreateUser role assignment', () => {
  it('makes the creator of a new organization ADMIN even if metadata says MEMBER', async () => {
    await findOrCreateUser({ ...base, firmName: 'Firm LLC', role: 'MEMBER' });
    expect(userInserts[0].organizationId).toBe('org-new');
    expect(userInserts[0].role).toBe('ADMIN');
  });

  it('keeps the invited role when no new organization is created', async () => {
    await findOrCreateUser({ ...base, role: 'VIEWER' });
    expect(userInserts[0].organizationId).toBeNull();
    expect(userInserts[0].role).toBe('VIEWER');
  });

  it('does not change an existing user', async () => {
    existingUser = { id: 'u1', authId: 'auth-1', role: 'MEMBER', organizationId: 'org-x' };
    const u = await findOrCreateUser({ ...base, firmName: 'Firm LLC', role: 'MEMBER' });
    expect(userInserts).toHaveLength(0);
    expect(u.role).toBe('MEMBER');
  });
});

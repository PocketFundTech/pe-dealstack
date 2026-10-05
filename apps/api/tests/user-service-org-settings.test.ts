/**
 * Regression test for the "Firm Profile fields lost after reload" bug
 * (observed live 2026-09-30):
 *
 *   1. Settings -> Firm Profile: user fills "Firm website" / "LinkedIn URL",
 *      clicks Save -> POST /api/onboarding/firm-inputs writes
 *      Organization.settings.firmWebsite / firmLinkedin (see
 *      apps/api/src/routes/onboarding.ts).
 *   2. On reload, the Settings UI seeds its fields from GET /api/users/me's
 *      `organization.settings` (see apps/web-next/.../FirmProfileSection.tsx
 *      applyFirmProfile()).
 *   3. GET /api/users/me is served by findOrCreateUser(), which joins
 *      Organization via a hand-picked column list that never included
 *      `settings` (or `website`) — so the field the UI reads is always
 *      undefined, regardless of what was actually saved.
 *
 * This test asserts findOrCreateUser's Organization join selects `settings`
 * (and `website`) so the saved fields survive a reload.
 */
import { describe, it, expect, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({ mockSupabase: { from: vi.fn() } }));
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findOrCreateUser } from '../src/services/userService.js';

function mockUserTable(selectSpy: (sel: string) => void, userRow: any) {
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'User') {
      return {
        select: (sel: string) => {
          selectSpy(sel);
          return {
            eq: () => ({
              single: async () => ({ data: userRow, error: null }),
            }),
          };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('findOrCreateUser — Organization join', () => {
  it('selects settings and website from Organization so Firm Profile fields survive reload', async () => {
    const selects: string[] = [];
    const userRow = {
      id: 'user-1',
      authId: 'auth-1',
      email: 'gst@chanakya.in',
      organization: {
        id: 'org-1',
        name: 'Chanakya Capital',
        slug: 'chanakya-capital',
        logo: null,
        plan: 'free',
        website: 'https://chanakya.in',
        settings: {
          firmWebsite: 'https://chanakya.in',
          firmLinkedin: 'https://linkedin.com/company/chanakya',
        },
      },
    };
    mockUserTable((sel) => selects.push(sel), userRow);

    const result = await findOrCreateUser({
      id: 'auth-1',
      email: 'gst@chanakya.in',
      role: 'ADMIN',
    });

    expect(result).toEqual(userRow);

    // Every User select in the lookup path must join Organization with
    // settings (+ website) included, not just id/name/slug/logo/plan.
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) {
      const orgJoinMatch = sel.match(/organization:Organization\(([^)]*)\)/);
      expect(orgJoinMatch, `select missing organization join: ${sel}`).toBeTruthy();
      const orgFields = orgJoinMatch![1].split(',').map((f) => f.trim());
      expect(orgFields).toContain('settings');
      expect(orgFields).toContain('website');
    }
  });
});

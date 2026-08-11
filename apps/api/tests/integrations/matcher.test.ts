import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  vi.resetModules();
});

describe('matcher.matchEmailAddressesToDeals', () => {
  it('returns matching contactIds and dealIds (case-insensitive email match)', async () => {
    const fromMock = vi.fn();
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [
          { id: 'c-1', email: 'john@acme.com' },
          { id: 'c-2', email: 'sara@beta.io' },
        ],
        error: null,
      }),
    });
    fromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{ dealId: 'd-1' }],
        error: null,
      }),
    });
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: fromMock } }));

    const { matchEmailAddressesToDeals } = await import(
      '../../src/integrations/_platform/matcher.js'
    );
    const result = await matchEmailAddressesToDeals({
      organizationId: 'org-1',
      emails: ['JOHN@acme.com', 'unknown@x.com'],
    });
    expect(result.matchedContactIds).toEqual(['c-1']);
    expect(result.matchedDealIds).toEqual(['d-1']);
  });

  it('returns empty arrays for empty input', async () => {
    vi.doMock('../../src/supabase.js', () => ({ supabase: { from: vi.fn() } }));
    const { matchEmailAddressesToDeals } = await import(
      '../../src/integrations/_platform/matcher.js'
    );
    const result = await matchEmailAddressesToDeals({
      organizationId: 'org-1',
      emails: [],
    });
    expect(result).toEqual({ matchedContactIds: [], matchedDealIds: [] });
  });
});

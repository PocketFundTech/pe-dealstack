import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mocks BEFORE importing the middleware
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

const logWarn = vi.fn();
const logInfo = vi.fn();
const logError = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  log: { info: logInfo, warn: logWarn, error: logError, debug: vi.fn() },
}));

vi.mock('../src/services/userService.js', () => ({
  findOrCreateUser: vi.fn(),
}));

/**
 * Build a fluent Supabase mock that lets each test scenario plug in a
 * different handler per .from('TABLE') call (or per call sequence).
 *
 * The middleware in the "user exists / no org" branch issues these calls
 * in order:
 *   1. .from('User').select('id, organizationId').eq('authId', X).single()  → resolve user
 *   2. .from('Organization').select('id').eq('name', firmName).single()    → existing-org probe
 *   3. .from('Organization').insert(...).select('id').single()              → create-org attempt
 *   4. (optional retry) same as #3
 *   5. .from('User').select('id, organizationId').eq('authId', X).single() → race re-fetch
 *   6. .from('User').update(...).eq('id', userId)                          → set organizationId
 */
type FromHandler = (table: string, callIndex: number) => any;

function installSupabaseHandler(handler: FromHandler) {
  const callsByTable = new Map<string, number>();
  mockSupabase.from.mockImplementation((table: string) => {
    const i = callsByTable.get(table) ?? 0;
    callsByTable.set(table, i + 1);
    return handler(table, i);
  });
}

const buildReq = (): Request =>
  ({ user: { id: 'auth-user-1', email: 'jane@acme.io', firmName: 'Acme Capital' } } as any);

const runMiddleware = async (req: Request) => {
  const { orgMiddleware } = await import('../src/middleware/orgScope.js');
  const next = vi.fn() as unknown as NextFunction;
  await orgMiddleware(req, {} as Response, next);
  return next;
};

describe('orgMiddleware — auto-create race fix (Task 6.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('happy path: user with no org → creates org and sets organizationId', async () => {
    let insertCount = 0;
    installSupabaseHandler((table, callIndex) => {
      if (table === 'User' && callIndex === 0) {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'user-1', organizationId: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'Organization' && callIndex === 0) {
        // existing-org probe → none found
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        };
      }
      if (table === 'Organization' && callIndex === 1) {
        // insert
        insertCount++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'org-new-1' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 1) {
        // race re-fetch — same user, still no org
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'user-1', organizationId: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 2) {
        // update
        return {
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      throw new Error(`Unexpected supabase.from(${table}) call #${callIndex}`);
    });

    const req = buildReq();
    const next = await runMiddleware(req);

    expect(req.user!.organizationId).toBe('org-new-1');
    expect(insertCount).toBe(1);
    expect(next).toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      'Org middleware: auto-created org for user without one',
      expect.objectContaining({ orgId: 'org-new-1' })
    );
  });

  it('retries insert once on Postgres 23505 unique-violation, succeeds on 2nd attempt', async () => {
    let insertAttempts = 0;
    installSupabaseHandler((table, callIndex) => {
      if (table === 'User' && callIndex === 0) {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'user-1', organizationId: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'Organization' && callIndex === 0) {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        };
      }
      // Org insert attempts: 1st fails with 23505, 2nd succeeds.
      if (table === 'Organization') {
        return {
          insert: () => ({
            select: () => ({
              single: () => {
                insertAttempts++;
                if (insertAttempts === 1) {
                  return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
                }
                return Promise.resolve({ data: { id: 'org-retry-2' }, error: null });
              },
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 1) {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'user-1', organizationId: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 2) {
        return {
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      throw new Error(`Unexpected supabase.from(${table}) call #${callIndex}`);
    });

    const req = buildReq();
    await runMiddleware(req);

    expect(insertAttempts).toBe(2);
    expect(req.user!.organizationId).toBe('org-retry-2');
    expect(logWarn).toHaveBeenCalledWith(
      'Org middleware: slug collision, retrying with new slug',
      expect.objectContaining({ attempt: 0 })
    );
  });

  it('race detected: parallel request set organizationId — uses parallel org, logs race', async () => {
    installSupabaseHandler((table, callIndex) => {
      if (table === 'User' && callIndex === 0) {
        // First read — no org yet.
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'user-1', organizationId: null }, error: null }),
            }),
          }),
        };
      }
      if (table === 'Organization' && callIndex === 0) {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        };
      }
      if (table === 'Organization' && callIndex === 1) {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'org-loser' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 1) {
        // Race re-fetch — parallel request already set organizationId.
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'user-1', organizationId: 'org-winner' },
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected supabase.from(${table}) call #${callIndex}`);
    });

    const req = buildReq();
    await runMiddleware(req);

    expect(req.user!.organizationId).toBe('org-winner');
    expect(logWarn).toHaveBeenCalledWith(
      'Org middleware: race detected — parallel request set organizationId, using existing',
      expect.objectContaining({
        parallelOrgId: 'org-winner',
        discardedOrgId: 'org-loser',
      })
    );
  });
});

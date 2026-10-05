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
 *   1. .from('User').select('id, organizationId').eq('authId', X).single()      → resolve user
 *   2. .from('Organization').insert(...).select('id').single()                  → create-org attempt
 *   3. .from('User').update({organizationId}).eq('id', userId)
 *        .is('organizationId', null).select('organizationId').maybeSingle()     → atomic claim
 *   4. (only if #3 claimed 0 rows) .from('User').select('id, organizationId')
 *        .eq('authId', X).single()                                              → re-read winner
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
        // insert — the middleware never probes for an existing org by name
        // (SECURITY: firmName is user-controlled; a name match would let a
        // user join another tenant's org).
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
        // atomic claim — no one else has raced, so the conditional update
        // matches this row and returns the org we just set.
        return {
          update: () => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: { organizationId: 'org-new-1' }, error: null }),
                }),
              }),
            }),
          }),
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

  it('insert failure (unique violation): no org attached, request continues without crash', async () => {
    // The old retry-on-23505 loop was removed deliberately: the slug now
    // embeds a timestamp + random suffix, making collisions ~impossible,
    // and the security model always creates a fresh org (never attaches by
    // name). On the residual failure path the middleware degrades
    // gracefully: no org set, next() still called.
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
      if (table === 'Organization') {
        return {
          insert: () => ({
            select: () => ({
              single: () => {
                insertAttempts++;
                return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
              },
            }),
          }),
        };
      }
      throw new Error(`Unexpected supabase.from(${table}) call #${callIndex}`);
    });

    const req = buildReq();
    const next = await runMiddleware(req);

    expect(insertAttempts).toBe(1);
    expect(req.user!.organizationId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('race detected: parallel request already claimed organizationId — atomic update matches zero rows, re-reads winner, logs race', async () => {
    installSupabaseHandler((table, callIndex) => {
      if (table === 'User' && callIndex === 0) {
        // First read — no org yet (this request hasn't seen the winner commit).
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
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'org-loser' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 1) {
        // Atomic claim — by the time this UPDATE ... WHERE organizationId
        // IS NULL runs, a parallel request has already committed its own
        // org, so the WHERE clause matches zero rows: maybeSingle() → null.
        return {
          update: () => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 2) {
        // Re-read after losing the claim — sees the winner's committed org.
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

  it('double race (the actual NDA-template bug): two concurrent requests both see organizationId null — only one atomic UPDATE can win, the other must adopt the winner instead of silently keeping its own orphaned org', async () => {
    // This is the scenario the old SELECT-then-UPDATE guard could not catch:
    // both racers' initial reads AND their (former) re-fetch both observed
    // organizationId: null, because neither had written yet. With the old
    // code, BOTH would fall into the "I'm first" branch and unconditionally
    // UPDATE — whichever ran last would silently win in Postgres, while the
    // other request's response had already gone out using its own (now
    // orphaned) org. A row inserted under the loser's org — e.g. an admin's
    // NDA template — would be invisible to every future request, forever,
    // including after a full reload.
    //
    // With the atomic `.is('organizationId', null)` guard, only one UPDATE
    // can match per racer even if both attempt it "simultaneously": the DB
    // serializes the two UPDATE statements, so the second one's WHERE
    // clause no longer matches (the column is no longer null) and it must
    // fall back to re-reading the authoritative value.
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
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'org-B' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 1) {
        // Request B's atomic claim runs AFTER request A already committed
        // org-A in the DB (simulated by this WHERE-clause miss), even
        // though B's own earlier read (callIndex 0) still saw null.
        return {
          update: () => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'User' && callIndex === 2) {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 'user-1', organizationId: 'org-A' },
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

    // Request B must end up on org-A (the actual committed winner), never
    // on its own org-B — otherwise anything B does under req.user.organizationId
    // (e.g. inserting a LegalDocTemplate) gets orphaned under org-B and is
    // permanently invisible to every future request, which always reads org-A.
    expect(req.user!.organizationId).toBe('org-A');
    expect(req.user!.organizationId).not.toBe('org-B');
    expect(logWarn).toHaveBeenCalledWith(
      'Org middleware: race detected — parallel request set organizationId, using existing',
      expect.objectContaining({
        parallelOrgId: 'org-A',
        discardedOrgId: 'org-B',
      })
    );
  });
});

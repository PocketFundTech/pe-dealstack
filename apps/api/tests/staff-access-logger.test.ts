import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must register BEFORE the middleware import so its top-level imports
// resolve to the mocked module.
vi.mock('../src/services/auditLog.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue({ data: {}, error: null }),
  AUDIT_ACTIONS: {
    STAFF_ACCESS: 'STAFF_ACCESS',
    STAFF_WEBHOOK_TEST: 'STAFF_WEBHOOK_TEST',
  },
  RESOURCE_TYPES: { SETTINGS: 'SETTINGS' },
  SEVERITY: { WARNING: 'WARNING' },
}));

vi.mock('../src/services/staffAccessNotifier.js', () => ({
  notifyStaffAccess: vi.fn().mockResolvedValue(undefined),
}));

import { staffAccessLogger } from '../src/middleware/staffAccessLogger.js';
import { logAuditEvent } from '../src/services/auditLog.js';
import { notifyStaffAccess } from '../src/services/staffAccessNotifier.js';

const mockReq = (over: Partial<any> = {}) => ({
  user: {
    id: 'staff-user-id',
    email: 'engineer@pocket-fund.com',
    organizationId: 'cust-org-1',
  },
  originalUrl: '/api/deals',
  method: 'GET',
  ip: '203.0.113.1',
  get: () => 'Mozilla/5.0 (test)',
  ...over,
});

const flushAsync = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

describe('staffAccessLogger', () => {
  beforeEach(() => {
    process.env.POCKET_FUND_STAFF_EMAILS =
      'engineer@pocket-fund.com,founder@pocket-fund.com';
    (logAuditEvent as any).mockClear();
    (notifyStaffAccess as any).mockClear();
  });

  it('logs STAFF_ACCESS when a staff user hits an instrumented data route', async () => {
    const next = vi.fn();
    staffAccessLogger(mockReq() as any, {} as any, next);
    expect(next).toHaveBeenCalled();

    await flushAsync();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    const callArgs = (logAuditEvent as any).mock.calls[0][0];
    expect(callArgs).toMatchObject({
      action: 'STAFF_ACCESS',
      organizationId: 'cust-org-1',
      severity: 'WARNING',
    });
    expect(callArgs.metadata).toMatchObject({
      staffEmail: 'engineer@pocket-fund.com',
      method: 'GET',
      path: '/api/deals',
    });
  });

  it('also fires the customer notifier (best-effort)', async () => {
    const next = vi.fn();
    staffAccessLogger(mockReq() as any, {} as any, next);
    await flushAsync();
    expect(notifyStaffAccess).toHaveBeenCalledTimes(1);
    expect((notifyStaffAccess as any).mock.calls[0][0]).toBe('cust-org-1');
  });

  it('does NOT log when user is not staff', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ user: { id: 'u1', email: 'customer@example.com', organizationId: 'org1' } }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
    expect(notifyStaffAccess).not.toHaveBeenCalled();
  });

  it('does NOT log when path is not in INSTRUMENTED_PREFIXES', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ originalUrl: '/api/auth/sessions' }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('does NOT log when path is /api/users/me (excluded)', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ originalUrl: '/api/users/me' }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('does NOT log when path is /api/organizations/me (excluded)', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ originalUrl: '/api/organizations/me' }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('case-insensitive match on POCKET_FUND_STAFF_EMAILS', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ user: { id: 'x', email: 'ENGINEER@POCKET-FUND.COM', organizationId: 'cust-org-1' } }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('strips query string before path-prefix match', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ originalUrl: '/api/deals?stage=screening&limit=10' }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect((logAuditEvent as any).mock.calls[0][0].metadata.path).toBe(
      '/api/deals',
    );
  });

  it('always calls next() even on logger failure', async () => {
    (logAuditEvent as any).mockRejectedValueOnce(new Error('db down'));
    const next = vi.fn();
    staffAccessLogger(mockReq() as any, {} as any, next);
    await flushAsync();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('no-ops cleanly when POCKET_FUND_STAFF_EMAILS is unset', async () => {
    delete process.env.POCKET_FUND_STAFF_EMAILS;
    const next = vi.fn();
    staffAccessLogger(mockReq() as any, {} as any, next);
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('skips when there is no req.user', async () => {
    const next = vi.fn();
    staffAccessLogger({ originalUrl: '/api/deals', method: 'GET', get: () => '' } as any, {} as any, next);
    await flushAsync();
    expect(next).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('skips when user has no organizationId', async () => {
    const next = vi.fn();
    staffAccessLogger(
      mockReq({ user: { id: 'u', email: 'engineer@pocket-fund.com', organizationId: undefined } }) as any,
      {} as any,
      next,
    );
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('matches /api/deals exactly (no path)', async () => {
    const next = vi.fn();
    staffAccessLogger(mockReq({ originalUrl: '/api/deals' }) as any, {} as any, next);
    await flushAsync();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('matches /api/deals/abc-123 (subpath)', async () => {
    const next = vi.fn();
    staffAccessLogger(mockReq({ originalUrl: '/api/deals/abc-123' }) as any, {} as any, next);
    await flushAsync();
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('does NOT match /api/dealsXY (prefix lookalike)', async () => {
    const next = vi.fn();
    staffAccessLogger(mockReq({ originalUrl: '/api/dealsXY' }) as any, {} as any, next);
    await flushAsync();
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

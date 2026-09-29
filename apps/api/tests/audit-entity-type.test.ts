/**
 * PROD BUG (2026-09-29): every deal-chat audit entry was rejected by the
 * database — `null value in column "entityType" of relation "AuditLog"
 * violates not-null constraint` — because AuditLog.aiChat passed no
 * resource type. Result: zero AI_CHAT rows in the audit trail since August.
 * The login/logout helpers had the same latent gap.
 *
 * Every audit event must reach the DB with an entityType.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      }),
    })),
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const req: any = {
  user: { id: 'user-1', email: 'g@example.com', role: 'ADMIN', organizationId: 'org-1' },
  params: { dealId: 'deal-1' },
  headers: {},
  ip: '127.0.0.1',
};

beforeEach(() => { inserted.length = 0; });

describe('audit entries always carry an entityType', () => {
  it('records deal chat against the deal', async () => {
    const { AuditLog } = await import('../src/services/auditLog.js');
    await AuditLog.aiChat(req, 'Deal: Nino Burgers (streaming)', 'deal-1');
    expect(inserted[0]).toMatchObject({ action: 'AI_CHAT', entityType: 'DEAL', entityId: 'deal-1' });
  });

  it('records login, failed login and logout against the user', async () => {
    const { AuditLog } = await import('../src/services/auditLog.js');
    await AuditLog.loginSuccess(req, 'user-1', 'g@example.com');
    await AuditLog.loginFailed(req, 'g@example.com', 'bad password');
    await AuditLog.logout(req);
    expect(inserted.map((r) => r.entityType)).toEqual(['USER', 'USER', 'USER']);
    expect(inserted[0].entityId).toBe('user-1');
  });

  it('never sends a null entityType, even when a caller omits the resource type', async () => {
    const { logAuditEvent } = await import('../src/services/auditLog.js');
    await logAuditEvent({ action: 'SETTINGS_CHANGED' as any, userId: 'user-1' }, req);
    expect(inserted[0].entityType).toBeTruthy();
  });
});

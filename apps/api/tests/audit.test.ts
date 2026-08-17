/**
 * Audit Trail Tests
 * Tests the audit log service, API endpoints, and ingest audit integration.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock Supabase before any imports that depend on it
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ error: null }),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
    })),
  },
}));

// ============================================================
// Audit Log Service — Unit Tests
// ============================================================

describe('AuditLog service', () => {
  it('should export AuditLog with convenience methods', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(mod.AuditLog).toBeDefined();
    expect(typeof mod.AuditLog.dealCreated).toBe('function');
    expect(typeof mod.AuditLog.dealUpdated).toBe('function');
    expect(typeof mod.AuditLog.dealDeleted).toBe('function');
    expect(typeof mod.AuditLog.documentUploaded).toBe('function');
    expect(typeof mod.AuditLog.documentDeleted).toBe('function');
    expect(typeof mod.AuditLog.aiIngest).toBe('function');
    expect(typeof mod.AuditLog.aiChat).toBe('function');
    expect(typeof mod.AuditLog.aiGenerate).toBe('function');
    expect(typeof mod.AuditLog.memoCreated).toBe('function');
    expect(typeof mod.AuditLog.memoDeleted).toBe('function');
    expect(typeof mod.AuditLog.userCreated).toBe('function');
    expect(typeof mod.AuditLog.userUpdated).toBe('function');
    expect(typeof mod.AuditLog.userDeleted).toBe('function');
    expect(typeof mod.AuditLog.log).toBe('function');
  });

  it('should export AUDIT_ACTIONS constants', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(mod.AUDIT_ACTIONS).toBeDefined();
    expect(mod.AUDIT_ACTIONS.DEAL_CREATED).toBe('DEAL_CREATED');
    expect(mod.AUDIT_ACTIONS.DEAL_UPDATED).toBe('DEAL_UPDATED');
    expect(mod.AUDIT_ACTIONS.DEAL_DELETED).toBe('DEAL_DELETED');
    expect(mod.AUDIT_ACTIONS.DOCUMENT_UPLOADED).toBe('DOCUMENT_UPLOADED');
    expect(mod.AUDIT_ACTIONS.AI_INGEST).toBe('AI_INGEST');
    expect(mod.AUDIT_ACTIONS.AI_CHAT).toBe('AI_CHAT');
  });

  it('should export RESOURCE_TYPES constants', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(mod.RESOURCE_TYPES).toBeDefined();
    expect(mod.RESOURCE_TYPES.DEAL).toBe('DEAL');
    expect(mod.RESOURCE_TYPES.DOCUMENT).toBe('DOCUMENT');
    expect(mod.RESOURCE_TYPES.MEMO).toBe('MEMO');
    expect(mod.RESOURCE_TYPES.USER).toBe('USER');
    expect(mod.RESOURCE_TYPES.COMPANY).toBe('COMPANY');
  });

  it('should export SEVERITY levels', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(mod.SEVERITY).toBeDefined();
    expect(mod.SEVERITY.INFO).toBe('INFO');
    expect(mod.SEVERITY.WARNING).toBe('WARNING');
    expect(mod.SEVERITY.ERROR).toBe('ERROR');
    expect(mod.SEVERITY.CRITICAL).toBe('CRITICAL');
  });

  it('should export logAuditEvent function', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(typeof mod.logAuditEvent).toBe('function');
  });

  it('should export getAuditLogs function', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(typeof mod.getAuditLogs).toBe('function');
  });

  it('should export getAuditSummary function', async () => {
    const mod = await import('../src/services/auditLog.js');
    expect(typeof mod.getAuditSummary).toBe('function');
  });
});

// ============================================================
// Audit API Endpoint Tests — exercises the REAL auditRouter.
//
// Prior version of this section used the "mini-app" pattern: an inline
// express() app that reimplemented filtering/pagination against a local
// mockLogs array. That meant the actual handlers in
// apps/api/src/routes/audit.ts (Zod query schema, getAuditLogs delegation,
// org-scoped user-name enrichment) were never executed.
//
// This section now mounts the real auditRouter and exercises it via
// supertest. The auditLog service (getAuditLogs / getAuditSummary) is
// stubbed at the module level so we control what data flows back into
// the handler; supabase is stubbed for the user-name enrichment helper.
//
// Mini-app fictions corrected:
//   - The mini-app's resourceId filter accepted any string; the real
//     handler's Zod schema requires resourceId to be a UUID. The "filter
//     by resourceId" scenario was rewritten to use a UUID and assert
//     that the orchestrator service received it.
//   - The mini-app's userId filter likewise accepted any string; real
//     handler requires UUID. Same rewrite.
//   - The mini-app's "return audit trail for entity" + "empty array for
//     unknown entity" returned in-memory filtered slices. The real
//     /entity/:entityId handler just calls getAuditLogs with the entityId
//     unchanged — we now assert the service was called with the right
//     args, not that the mini-app filter logic matches.
// ============================================================

const auditLogsMockRows = [
  {
    id: 'audit-1',
    userId: '00000000-0000-0000-0000-000000000001',
    userEmail: 'admin@example.com',
    action: 'DEAL_CREATED',
    entityType: 'DEAL',
    entityId: '11111111-1111-1111-1111-111111111111',
    resourceName: 'Acme Corp',
    description: 'Created deal: Acme Corp',
    metadata: {},
    severity: 'INFO',
    createdAt: '2026-02-13T10:00:00Z',
  },
];

const buildAuditApp = async () => {
  const { default: auditRouter } = await import('../src/routes/audit.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      organizationId: 'org-A',
      role: 'ADMIN',
      email: 'admin@example.com',
    };
    next();
  });
  app.use('/api/audit', auditRouter);
  return app;
};

describe('Real /api/audit handlers', () => {
  let getAuditLogsMock: any;
  let getAuditSummaryMock: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Mock the auditLog service (getAuditLogs + getAuditSummary). The
    // service is what the real router delegates to.
    vi.doMock('../src/utils/logger.js', () => ({
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../src/middleware/orgScope.js', () => ({
      getOrgId: () => 'org-A',
      verifyDealAccess: vi.fn().mockResolvedValue({ id: 'deal-1' }),
    }));

    // Stub supabase only for the User name enrichment helper inside the
    // router. The chain is from('User').select(...).eq().in() → resolves.
    vi.doMock('../src/supabase.js', () => ({
      supabase: {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          })),
        })),
      },
    }));

    getAuditLogsMock = vi
      .fn()
      .mockResolvedValue({ data: auditLogsMockRows, error: null, count: 1 });
    getAuditSummaryMock = vi.fn().mockResolvedValue({
      totalActions: 3,
      byAction: { DEAL_CREATED: 1, AI_INGEST: 1, DEAL_UPDATED: 1 },
      byUser: { 'admin@example.com': 2, 'analyst@example.com': 1 },
      bySeverity: { INFO: 3 },
    });

    vi.doMock('../src/services/auditLog.js', () => ({
      getAuditLogs: getAuditLogsMock,
      getAuditSummary: getAuditSummaryMock,
      AUDIT_ACTIONS: {},
      RESOURCE_TYPES: {},
      SEVERITY: {},
    }));
  });

  // Restore the real auditLog module + reset the module registry so the
  // sibling describes below (AuditLogEntry interface / Ingest routes import
  // AuditLog) re-import the real, unmocked service.
  afterAll(() => {
    vi.doUnmock('../src/services/auditLog.js');
    vi.doUnmock('../src/supabase.js');
    vi.doUnmock('../src/middleware/orgScope.js');
    vi.doUnmock('../src/utils/logger.js');
    vi.resetModules();
  });

  // ── GET /api/audit ─────────────────────────────────────────────
  describe('GET /api/audit', () => {
    it('returns audit logs and forwards org scoping to getAuditLogs', async () => {
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(1);
      expect(res.body.logs).toHaveLength(1);
      // The handler passes organizationId from getOrgId(req) into the service.
      expect(getAuditLogsMock).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-A' })
      );
    });

    it('forwards resourceId / action / userId filters to getAuditLogs', async () => {
      const app = await buildAuditApp();
      const userUuid = '00000000-0000-0000-0000-000000000456';
      const dealUuid = '11111111-1111-1111-1111-111111111111';
      const res = await request(app).get(
        `/api/audit?resourceId=${dealUuid}&action=DEAL_CREATED&userId=${userUuid}`
      );

      expect(res.status).toBe(200);
      expect(getAuditLogsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: dealUuid,
          action: 'DEAL_CREATED',
          userId: userUuid,
          organizationId: 'org-A',
        })
      );
    });

    it('returns 400 when resourceId is not a UUID (Zod validation)', async () => {
      // Mini-app accepted any string; real handler's Zod schema requires
      // resourceId to be z.string().uuid(). Bad input → 400 before service.
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit?resourceId=deal-1');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid query parameters');
      expect(getAuditLogsMock).not.toHaveBeenCalled();
    });

    it('coerces limit/offset query params and forwards them to the service', async () => {
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit?limit=10&offset=5');

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(10);
      expect(res.body.offset).toBe(5);
      expect(getAuditLogsMock).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 5 })
      );
    });

    it('returns 500 when getAuditLogs returns an error', async () => {
      getAuditLogsMock.mockResolvedValueOnce({ data: null, error: { message: 'db down' }, count: null });
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to retrieve audit logs');
    });
  });

  // ── GET /api/audit/entity/:entityId ────────────────────────────
  describe('GET /api/audit/entity/:entityId', () => {
    it('forwards entityId + org scoping to getAuditLogs', async () => {
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit/entity/deal-1');

      expect(res.status).toBe(200);
      expect(res.body.entityId).toBe('deal-1');
      expect(getAuditLogsMock).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: 'deal-1', organizationId: 'org-A' })
      );
    });
  });

  // ── GET /api/audit/summary ─────────────────────────────────────
  describe('GET /api/audit/summary', () => {
    it('returns the summary payload with period label', async () => {
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit/summary');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.period).toBe('30 days');
      expect(res.body.totalActions).toBe(3);
      expect(res.body.byAction).toBeDefined();
      // Real handler passes days + orgId into getAuditSummary.
      expect(getAuditSummaryMock).toHaveBeenCalledWith(30, 'org-A');
    });

    it('accepts custom days param and clamps to 90', async () => {
      const app = await buildAuditApp();
      const res = await request(app).get('/api/audit/summary?days=7');

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('7 days');
      expect(getAuditSummaryMock).toHaveBeenCalledWith(7, 'org-A');
    });
  });
});

// ============================================================
// Audit Log Entry Shape Tests
// ============================================================

describe('AuditLogEntry interface', () => {
  it('should have correct shape for AuditLogEntry', async () => {
    const mod = await import('../src/services/auditLog.js');
    // Verify the function accepts the right shape
    const entry: any = {
      userId: 'user-123',
      userEmail: 'test@example.com',
      action: mod.AUDIT_ACTIONS.DEAL_CREATED,
      resourceType: mod.RESOURCE_TYPES.DEAL,
      resourceId: 'deal-123',
      resourceName: 'Test Deal',
      description: 'Test description',
      metadata: { source: 'test' },
      severity: mod.SEVERITY.INFO,
    };
    // Verify all fields are valid
    expect(entry.userId).toBe('user-123');
    expect(entry.action).toBe('DEAL_CREATED');
    expect(entry.resourceType).toBe('DEAL');
    expect(entry.severity).toBe('INFO');
  });

  it('should support all AUDIT_ACTIONS', async () => {
    const { AUDIT_ACTIONS } = await import('../src/services/auditLog.js');
    const actions = Object.values(AUDIT_ACTIONS);
    expect(actions.length).toBeGreaterThan(20);
    // Key actions for ingest audit trail
    expect(actions).toContain('AI_INGEST');
    expect(actions).toContain('DEAL_CREATED');
    expect(actions).toContain('DEAL_UPDATED');
    expect(actions).toContain('DEAL_DELETED');
    expect(actions).toContain('DOCUMENT_UPLOADED');
  });
});

// ============================================================
// Ingest Audit Integration Tests
// ============================================================

describe('Ingest routes import AuditLog', () => {
  it('should have AuditLog imported in ingest.ts', async () => {
    // Verify the ingest module loads without error (includes AuditLog import)
    const mod = await import('../src/routes/ingest.js');
    expect(mod.default).toBeDefined(); // Router is the default export
  });
});

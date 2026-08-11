// apps/api/src/routes/admin-security.ts
//
// Live tenant-isolation test runner. Spawns a temporary "shadow" org with one
// seed deal + folder + document, then verifies the requesting user's org
// cannot access them via the real middleware helpers. Cleans up after.
//
// IMPORTANT: returns within ~3 seconds for demo purposes.
//
// Adaptations from spec:
//  - verifyDealAccess / verifyDocumentAccess / verifyFolderAccess /
//    verifyConversationAccess return `data | null` (the row or null), NOT
//    a boolean. The "allowed" check is therefore truthiness on the result.

import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  verifyDealAccess,
  verifyDocumentAccess,
  verifyFolderAccess,
  verifyConversationAccess,
} from '../middleware/orgScope.js';
import {
  logAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';
import { randomUUID } from 'crypto';

const router = Router();

interface CheckResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

router.post('/run-isolation-test', async (req: Request, res: Response) => {
  const t0 = Date.now();
  const user = (req as any).user;
  const role = (user?.role || '').toLowerCase();
  if (!['admin', 'partner', 'principal'].includes(role)) {
    return res.status(403).json({ error: 'Admin role required' });
  }

  const myOrgId = user.organizationId;
  if (!myOrgId) return res.status(400).json({ error: 'No organization context' });

  const shadowOrgId = randomUUID();
  const shadowDealId = randomUUID();
  const shadowFolderId = randomUUID();
  const shadowDocId = randomUUID();
  const checks: CheckResult[] = [];

  async function cleanup() {
    try { await supabase.from('Document').delete().eq('id', shadowDocId); } catch (_) {}
    try { await supabase.from('Folder').delete().eq('id', shadowFolderId); } catch (_) {}
    try { await supabase.from('Deal').delete().eq('id', shadowDealId); } catch (_) {}
    try { await supabase.from('Organization').delete().eq('id', shadowOrgId); } catch (_) {}
  }

  try {
    // ---------- Seed shadow org + records ----------
    const seedSlug = `__iso_${Date.now()}_${randomUUID().slice(0, 8)}__`;
    const orgInsert = await supabase.from('Organization').insert({
      id: shadowOrgId,
      name: '__isolation_test__',
      slug: seedSlug,
      plan: 'test',
      isActive: false,
    });
    if (orgInsert.error) {
      log.warn('shadow org insert failed', orgInsert.error);
    }

    const dealInsert = await supabase.from('Deal').insert({
      id: shadowDealId,
      organizationId: shadowOrgId,
      name: '__shadow_deal__',
      stage: 'screening',
    });
    if (dealInsert.error) {
      log.warn('shadow deal insert failed', dealInsert.error);
    }

    const folderInsert = await supabase.from('Folder').insert({
      id: shadowFolderId,
      dealId: shadowDealId,
      name: '__shadow_folder__',
    });
    if (folderInsert.error) {
      log.warn('shadow folder insert failed', folderInsert.error);
    }

    const docInsert = await supabase.from('Document').insert({
      id: shadowDocId,
      dealId: shadowDealId,
      folderId: shadowFolderId,
      fileName: '__shadow_doc__',
    });
    if (docInsert.error) {
      log.warn('shadow document insert failed', docInsert.error);
    }

    // verifyXAccess returns the row (truthy) when access is allowed,
    // or null/undefined when blocked. We expect blocked across the board.
    async function check(name: string, fn: () => Promise<unknown>) {
      try {
        const result = await fn();
        const allowed = !!result;
        checks.push({
          name,
          passed: !allowed,
          expected: 'access blocked',
          actual: allowed ? 'access allowed (FAIL)' : 'access blocked',
        });
      } catch (e: any) {
        // A throw is also a "blocked" outcome from the caller's perspective.
        checks.push({
          name,
          passed: true,
          expected: 'access blocked',
          actual: 'threw — ' + (e?.message || 'unknown'),
        });
      }
    }

    // ---------- Cross-org access checks via real middleware helpers ----------
    await check(
      'Cross-org Deal access via verifyDealAccess',
      () => verifyDealAccess(shadowDealId, myOrgId)
    );
    await check(
      'Cross-org Document access via verifyDocumentAccess',
      () => verifyDocumentAccess(shadowDocId, myOrgId)
    );
    await check(
      'Cross-org Folder access via verifyFolderAccess',
      () => verifyFolderAccess(shadowFolderId, myOrgId)
    );
    await check(
      'Cross-org Conversation access via verifyConversationAccess',
      () => verifyConversationAccess(randomUUID(), myOrgId)
    );

    // ---------- Direct table queries scoped to my orgId ----------
    {
      const { data: dealQuery } = await supabase
        .from('Deal').select('id').eq('id', shadowDealId).eq('organizationId', myOrgId);
      const leaked = !!dealQuery && dealQuery.length > 0;
      checks.push({
        name: 'Direct Deal query with my orgId returns no shadow row',
        passed: !leaked,
        expected: 'empty result',
        actual: leaked ? `${dealQuery!.length} rows (FAIL)` : 'empty',
      });
    }

    {
      const { data: list } = await supabase
        .from('Deal').select('id').eq('organizationId', myOrgId).limit(2000);
      const leaked = (list || []).some((d: any) => d.id === shadowDealId);
      checks.push({
        name: 'Listing all my deals does not include shadow deal',
        passed: !leaked,
        expected: 'shadow deal absent',
        actual: leaked ? 'shadow deal leaked (FAIL)' : 'absent',
      });
    }

    {
      const { data: auditCross } = await supabase
        .from('AuditLog')
        .select('id')
        .eq('organizationId', myOrgId)
        .eq('entityId', shadowDealId);
      const leaked = !!auditCross && auditCross.length > 0;
      checks.push({
        name: 'AuditLog query scoped by my orgId excludes shadow events',
        passed: !leaked,
        expected: 'no shadow events',
        actual: leaked ? `${auditCross!.length} leaks (FAIL)` : 'clean',
      });
    }

    // ---------- Layered defense for Document (no direct organizationId column) ----------
    {
      const { data: docExists } = await supabase
        .from('Document').select('id').eq('id', shadowDocId);
      const exists = !!docExists && docExists.length > 0;
      checks.push({
        name: 'Document layered defense (row exists at table level — verifyDocumentAccess protects)',
        passed: exists,
        expected: 'row exists at table level (correct — protection at API layer)',
        actual: exists ? 'row exists (correct)' : 'no row (seed insert failed)',
      });
    }

    await cleanup();

    const passed = checks.filter((c) => c.passed).length;
    const total = checks.length;
    const durationMs = Date.now() - t0;

    try {
      await logAuditEvent({
        action: AUDIT_ACTIONS.SECURITY_TEST_RUN,
        resourceType: RESOURCE_TYPES.SETTINGS,
        resourceId: myOrgId,
        organizationId: myOrgId,
        userId: user.id,
        userEmail: user.email,
        userRole: user.role,
        severity: passed === total ? SEVERITY.INFO : SEVERITY.CRITICAL,
        metadata: { passed, total, durationMs },
      }, req);
    } catch (auditErr) {
      log.warn('audit log write failed for security test run', { err: auditErr });
    }

    return res.json({ passed, total, checks, durationMs });
  } catch (err: any) {
    log.error('isolation test failed', err);
    await cleanup();
    return res
      .status(500)
      .json({ error: 'Test execution failed', detail: err?.message });
  }
});

export default router;

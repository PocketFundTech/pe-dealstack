import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import { getAuditLogs, AUDIT_ACTIONS } from '../services/auditLog.js';

const router = Router();

const ADMIN_ROLES = new Set(['admin', 'partner', 'principal']);

interface RecentAdminAction {
  action: string;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
}

interface TopDealEntry {
  dealId: string;
  dealName: string | null;
  views: number;
  uniqueViewers: number;
}

async function fetchActiveSessions(orgId: string): Promise<number | null> {
  // Best-effort. Requires `auth` schema exposed in PostgREST. If not exposed,
  // returns null and the dashboard shows "Unavailable".
  try {
    const { data: users, error: usersErr } = await supabase
      .from('User')
      .select('authId')
      .eq('organizationId', orgId);
    if (usersErr || !users) return null;
    const authIds = users.map((u: { authId: string | null }) => u.authId).filter(Boolean) as string[];
    if (authIds.length === 0) return 0;

    const { data: sessions, error: sErr } = await supabase
      .schema('auth' as any)
      .from('sessions')
      .select('id')
      .in('user_id', authIds);
    if (sErr || !sessions) return null;
    return sessions.length;
  } catch (err) {
    log.warn('dashboard: active sessions lookup failed (auth schema likely not exposed)', { err });
    return null;
  }
}

async function fetchMembers(orgId: string): Promise<{ total: number; mfaEnrolled: number | null; mfaPercent: number | null }> {
  try {
    const { count, error } = await supabase
      .from('User')
      .select('id', { count: 'exact', head: true })
      .eq('organizationId', orgId);
    if (error) return { total: 0, mfaEnrolled: null, mfaPercent: null };
    return { total: count ?? 0, mfaEnrolled: null, mfaPercent: null };
  } catch (err) {
    log.warn('dashboard: members count failed', { err });
    return { total: 0, mfaEnrolled: null, mfaPercent: null };
  }
}

async function fetchOrgRequireMfa(orgId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('Organization')
      .select('requireMFA')
      .eq('id', orgId)
      .single();
    return !!data?.requireMFA;
  } catch {
    return false;
  }
}

async function fetchAuditCount(
  orgId: string,
  action: string,
  windowDays: number,
): Promise<number | null> {
  try {
    const startDate = new Date(Date.now() - windowDays * 86400_000);
    const { count, error } = await getAuditLogs({
      organizationId: orgId,
      action: action as any,
      startDate,
      limit: 1,
      offset: 0,
    });
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

async function fetchRecentAdminActions(
  orgId: string,
  windowDays: number,
): Promise<{ total: number; recent: RecentAdminAction[] }> {
  try {
    const ADMIN_ACTION_TYPES = [
      AUDIT_ACTIONS.USER_INVITED,
      AUDIT_ACTIONS.USER_ROLE_CHANGED,
      AUDIT_ACTIONS.USER_DELETED,
      AUDIT_ACTIONS.SETTINGS_CHANGED,
      AUDIT_ACTIONS.ORG_MFA_REQUIRED,
      AUDIT_ACTIONS.ORG_MFA_NOT_REQUIRED,
      AUDIT_ACTIONS.SECURITY_TEST_RUN,
      AUDIT_ACTIONS.STAFF_WEBHOOK_TEST,
    ];
    const startDate = new Date(Date.now() - windowDays * 86400_000);

    let total = 0;
    const recentBuckets: RecentAdminAction[] = [];
    for (const action of ADMIN_ACTION_TYPES) {
      const { data, count } = await getAuditLogs({
        organizationId: orgId,
        action: action as any,
        startDate,
        limit: 5,
        offset: 0,
      });
      if (typeof count === 'number') total += count;
      if (data) {
        for (const row of data as any[]) {
          recentBuckets.push({
            action: row.action,
            userName: row.userName ?? null,
            userEmail: row.userEmail ?? null,
            createdAt: row.createdAt,
          });
        }
      }
    }

    recentBuckets.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return { total, recent: recentBuckets.slice(0, 5) };
  } catch (err) {
    log.warn('dashboard: admin actions aggregation failed', { err });
    return { total: 0, recent: [] };
  }
}

async function fetchTopDeals(orgId: string, windowDays: number): Promise<TopDealEntry[]> {
  try {
    const startDate = new Date(Date.now() - windowDays * 86400_000);
    const { data } = await getAuditLogs({
      organizationId: orgId,
      action: AUDIT_ACTIONS.DEAL_VIEWED as any,
      startDate,
      limit: 1000,
      offset: 0,
    });
    if (!data) return [];

    const byDeal = new Map<
      string,
      { dealName: string | null; views: number; viewers: Set<string> }
    >();
    for (const row of data as any[]) {
      const dealId = row.entityId;
      if (!dealId) continue;
      const entry = byDeal.get(dealId) ?? {
        dealName: row.entityName ?? null,
        views: 0,
        viewers: new Set<string>(),
      };
      entry.views += 1;
      if (row.userId) entry.viewers.add(row.userId);
      if (!entry.dealName && row.entityName) entry.dealName = row.entityName;
      byDeal.set(dealId, entry);
    }

    const sorted = Array.from(byDeal.entries())
      .map(([dealId, e]) => ({
        dealId,
        dealName: e.dealName,
        views: e.views,
        uniqueViewers: e.viewers.size,
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5);
    return sorted;
  } catch (err) {
    log.warn('dashboard: top deals aggregation failed', { err });
    return [];
  }
}

/**
 * GET /api/admin/security/dashboard
 *
 * Aggregated security posture for the admin's org. Returns a 6-section
 * summary suitable for a single-screen compliance overview.
 *
 * Best-effort: individual sub-queries that fail return null/empty rather
 * than 500'ing the whole response.
 */
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const user = req.user;
    const role = (user?.role || '').toLowerCase();
    if (!user || !ADMIN_ROLES.has(role)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const orgId = getOrgId(req);

    const [
      activeSessions,
      members,
      requireMFA,
      staffAccessCount,
      failedLoginsCount,
      adminActions,
      topDeals,
    ] = await Promise.all([
      fetchActiveSessions(orgId),
      fetchMembers(orgId),
      fetchOrgRequireMfa(orgId),
      fetchAuditCount(orgId, AUDIT_ACTIONS.STAFF_ACCESS, 90),
      fetchAuditCount(orgId, AUDIT_ACTIONS.LOGIN_FAILED, 7),
      fetchRecentAdminActions(orgId, 30),
      fetchTopDeals(orgId, 30),
    ]);

    return res.json({
      windowDays: 30,
      activeSessions,
      members: {
        total: members.total,
        mfaEnrolled: members.mfaEnrolled,
        mfaPercent: members.mfaPercent,
        requireMFA,
      },
      staffAccess: {
        windowDays: 90,
        count: staffAccessCount,
      },
      failedLogins: {
        windowDays: 7,
        count: failedLoginsCount,
      },
      adminActions: {
        windowDays: 30,
        total: adminActions.total,
        recent: adminActions.recent,
      },
      topDeals,
    });
  } catch (err) {
    log.error('admin/security/dashboard error', err);
    return res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

export default router;

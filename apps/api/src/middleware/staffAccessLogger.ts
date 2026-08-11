import { Request, Response, NextFunction } from 'express';
import { log } from '../utils/logger.js';
import {
  logAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';
import { notifyStaffAccess } from '../services/staffAccessNotifier.js';

/**
 * Routes whose hits we count as "customer business data" access. Hitting any
 * of these as a Pocket Fund staff user generates a STAFF_ACCESS audit event
 * in the target customer's audit log.
 *
 * Excluded by design: /api/auth (sessions), /api/users/me (self),
 * /api/organizations/me (self-org config), /api/usage, /api/onboarding,
 * /api/notifications, /api/templates, /api/tasks, /api/admin/security
 * (the isolation test fires its own audit event).
 */
const INSTRUMENTED_PREFIXES = [
  '/api/deals',
  '/api/documents',
  '/api/folders',
  '/api/financials',
  '/api/memos',
  '/api/contacts',
  '/api/companies',
  '/api/audit',
];

let cachedStaffEmails: Set<string> | null = null;
let cachedRaw: string | undefined;

function staffEmails(): Set<string> {
  const raw = process.env.POCKET_FUND_STAFF_EMAILS;
  if (raw === cachedRaw && cachedStaffEmails) return cachedStaffEmails;
  cachedRaw = raw;
  const set = new Set<string>();
  if (raw) {
    for (const entry of raw.split(',')) {
      const cleaned = entry.trim().toLowerCase();
      if (cleaned) set.add(cleaned);
    }
  }
  cachedStaffEmails = set;
  return set;
}

/**
 * staffAccessLogger — runs after authMiddleware + orgMiddleware. When a
 * staff user (email in POCKET_FUND_STAFF_EMAILS) hits an instrumented data
 * route, write a STAFF_ACCESS audit event into the target organization's
 * audit log AND fire a customer-configured webhook + email notification.
 *
 * Best-effort. NEVER blocks the request. Audit + notification fire after
 * next() so a slow Slack webhook can't add latency to staff requests.
 */
export const staffAccessLogger = (req: Request, res: Response, next: NextFunction) => {
  next();

  // Run logging asynchronously after next() so we never add latency
  setImmediate(() => {
    try {
      const user = (req as any).user;
      if (!user || !user.email) return;

      const email = String(user.email).toLowerCase().trim();
      const allow = staffEmails();
      if (allow.size === 0 || !allow.has(email)) return;

      const path = (req.originalUrl || '').split('?')[0];
      if (!INSTRUMENTED_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) return;

      const orgId = user.organizationId;
      if (!orgId) return;

      const metadata = {
        staffEmail: email,
        method: req.method,
        path,
        ip: req.ip || null,
        ua: req.get('user-agent') || null,
      };

      // Fire the audit event and notification in parallel (both best-effort)
      void logAuditEvent(
        {
          action: AUDIT_ACTIONS.STAFF_ACCESS,
          resourceType: RESOURCE_TYPES.SETTINGS,
          resourceId: orgId,
          organizationId: orgId,
          userId: user.id,
          severity: SEVERITY.WARNING,
          metadata,
        },
        req,
      ).catch((err) => log.warn('staffAccessLogger: audit write failed', { err, orgId }));

      void notifyStaffAccess(orgId, {
        staffEmail: email,
        method: req.method,
        path,
      }).catch((err) => log.warn('staffAccessLogger: notify failed', { err, orgId }));
    } catch (err) {
      log.warn('staffAccessLogger: outer error', { err });
    }
  });
};

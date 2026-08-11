import { Request } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

/**
 * Audit Log Service
 * Tracks all sensitive actions for compliance and security
 */

// Action types
export const AUDIT_ACTIONS = {
  // Authentication
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',

  // Deal operations
  DEAL_CREATED: 'DEAL_CREATED',
  DEAL_UPDATED: 'DEAL_UPDATED',
  DEAL_DELETED: 'DEAL_DELETED',
  DEAL_VIEWED: 'DEAL_VIEWED',
  DEAL_STAGE_CHANGED: 'DEAL_STAGE_CHANGED',
  DEAL_ASSIGNED: 'DEAL_ASSIGNED',
  DEAL_EXPORTED: 'DEAL_EXPORTED',

  // Document operations
  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  DOCUMENT_DOWNLOADED: 'DOCUMENT_DOWNLOADED',
  DOCUMENT_VIEWED: 'DOCUMENT_VIEWED',

  // Memo operations
  MEMO_CREATED: 'MEMO_CREATED',
  MEMO_UPDATED: 'MEMO_UPDATED',
  MEMO_DELETED: 'MEMO_DELETED',
  MEMO_APPROVED: 'MEMO_APPROVED',
  MEMO_EXPORTED: 'MEMO_EXPORTED',
  MEMO_SHARED: 'MEMO_SHARED',

  // User management
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_INVITED: 'USER_INVITED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',

  // AI operations
  AI_CHAT: 'AI_CHAT',
  AI_GENERATE: 'AI_GENERATE',
  AI_INGEST: 'AI_INGEST',

  // Invitation operations
  INVITATION_SENT: 'INVITATION_SENT',
  INVITATION_ACCEPTED: 'INVITATION_ACCEPTED',
  INVITATION_REVOKED: 'INVITATION_REVOKED',

  // System operations
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  BULK_EXPORT: 'BULK_EXPORT',
  API_KEY_CREATED: 'API_KEY_CREATED',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  ORG_MFA_REQUIRED: 'ORG_MFA_REQUIRED',
  ORG_MFA_NOT_REQUIRED: 'ORG_MFA_NOT_REQUIRED',
  SECURITY_TEST_RUN: 'SECURITY_TEST_RUN',
  STAFF_ACCESS: 'STAFF_ACCESS',
  STAFF_WEBHOOK_TEST: 'STAFF_WEBHOOK_TEST',
  AI_INFERENCE: 'AI_INFERENCE',
} as const;

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

// Resource types
export const RESOURCE_TYPES = {
  DEAL: 'DEAL',
  DOCUMENT: 'DOCUMENT',
  MEMO: 'MEMO',
  USER: 'USER',
  COMPANY: 'COMPANY',
  FOLDER: 'FOLDER',
  SETTINGS: 'SETTINGS',
  API_KEY: 'API_KEY',
  INVITATION: 'INVITATION',
} as const;

export type ResourceType = typeof RESOURCE_TYPES[keyof typeof RESOURCE_TYPES];

// Severity levels
export const SEVERITY = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
} as const;

export type SeverityLevel = typeof SEVERITY[keyof typeof SEVERITY];

// Audit log entry interface
export interface AuditLogEntry {
  userId?: string;
  userEmail?: string;
  userRole?: string;
  organizationId?: string;
  action: AuditAction;
  resourceType?: ResourceType;
  resourceId?: string;
  resourceName?: string;
  description?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  severity?: SeverityLevel;
}

/**
 * Extract client info from request
 */
function getClientInfo(req?: Request): { ipAddress?: string; userAgent?: string; requestId?: string } {
  if (!req) return {};

  return {
    ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
               req.socket?.remoteAddress ||
               undefined,
    userAgent: req.headers['user-agent'] || undefined,
    requestId: req.headers['x-request-id'] as string || undefined,
  };
}

/**
 * Log an audit event
 */
export async function logAuditEvent(entry: AuditLogEntry, req?: Request): Promise<void> {
  try {
    const clientInfo = getClientInfo(req);

    // Map service fields to actual DB column names
    // DB uses: entityType, entityId, entityName, changes
    // Service uses: resourceType, resourceId, resourceName, metadata
    const { error } = await supabase.from('AuditLog').insert({
      userId: entry.userId,
      userEmail: entry.userEmail,
      userRole: entry.userRole,
      organizationId: entry.organizationId,
      action: entry.action,
      entityType: entry.resourceType,
      entityId: entry.resourceId,
      entityName: entry.resourceName,
      description: entry.description,
      metadata: entry.metadata || {},
      ipAddress: entry.ipAddress || clientInfo.ipAddress,
      userAgent: entry.userAgent || clientInfo.userAgent,
      requestId: entry.requestId || clientInfo.requestId,
      severity: entry.severity || SEVERITY.INFO,
    });

    if (error) {
      // Don't throw - audit logging should not break main functionality
      log.error('Audit log error', error);
    }
  } catch (err) {
    // Silently log errors - audit logging should never break the main operation
    log.error('Audit log exception', err);
  }
}

/**
 * Log an audit event from Express request (convenience method)
 */
export async function logFromRequest(
  req: Request,
  action: AuditAction,
  options: {
    resourceType?: ResourceType;
    resourceId?: string;
    resourceName?: string;
    description?: string;
    metadata?: Record<string, any>;
    severity?: SeverityLevel;
  } = {}
): Promise<void> {
  await logAuditEvent({
    userId: req.user?.id,
    userEmail: req.user?.email,
    userRole: req.user?.role,
    organizationId: (req.user as any)?.organizationId,
    action,
    ...options,
  }, req);
}

/**
 * Get audit logs with filtering
 */
export async function getAuditLogs(options: {
  userId?: string;
  action?: AuditAction;
  resourceType?: ResourceType;
  resourceId?: string;
  severity?: SeverityLevel;
  organizationId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
} = {}): Promise<{ data: any[] | null; error: any; count: number | null }> {
  let query = supabase
    .from('AuditLog')
    .select('*', { count: 'exact' })
    .order('createdAt', { ascending: false });

  if (options.organizationId) {
    query = query.eq('organizationId', options.organizationId);
  }

  if (options.userId) {
    query = query.eq('userId', options.userId);
  }

  if (options.action) {
    query = query.eq('action', options.action);
  }

  if (options.resourceType) {
    query = query.eq('entityType', options.resourceType);
  }

  if (options.resourceId) {
    query = query.eq('entityId', options.resourceId);
  }

  if (options.severity) {
    query = query.eq('severity', options.severity);
  }

  if (options.startDate) {
    query = query.gte('createdAt', options.startDate.toISOString());
  }

  if (options.endDate) {
    query = query.lte('createdAt', options.endDate.toISOString());
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error, count } = await query;

  return { data, error, count };
}

/**
 * Get audit summary statistics
 */
export async function getAuditSummary(days: number = 30, organizationId?: string): Promise<{
  totalActions: number;
  byAction: Record<string, number>;
  byUser: Record<string, number>;
  bySeverity: Record<string, number>;
}> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  let summaryQuery = supabase
    .from('AuditLog')
    .select('action, userEmail, severity')
    .gte('createdAt', startDate.toISOString());

  if (organizationId) {
    summaryQuery = summaryQuery.eq('organizationId', organizationId);
  }

  const { data } = await summaryQuery;

  const logs = data || [];

  const byAction: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};

  logs.forEach((log: any) => {
    byAction[log.action] = (byAction[log.action] || 0) + 1;
    if (log.userEmail) {
      byUser[log.userEmail] = (byUser[log.userEmail] || 0) + 1;
    }
    bySeverity[log.severity] = (bySeverity[log.severity] || 0) + 1;
  });

  return {
    totalActions: logs.length,
    byAction,
    byUser,
    bySeverity,
  };
}

// Export convenience functions for common audit actions
export const AuditLog = {
  // Authentication
  loginSuccess: (req: Request, userId: string, email: string) =>
    logAuditEvent({ userId, userEmail: email, action: AUDIT_ACTIONS.LOGIN }, req),

  loginFailed: (req: Request, email: string, reason?: string) =>
    logAuditEvent({
      userEmail: email,
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      severity: SEVERITY.WARNING,
      metadata: { reason },
    }, req),

  logout: (req: Request) =>
    logFromRequest(req, AUDIT_ACTIONS.LOGOUT),

  // Deals
  dealCreated: (req: Request, dealId: string, dealName: string) =>
    logFromRequest(req, AUDIT_ACTIONS.DEAL_CREATED, {
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: dealId,
      resourceName: dealName,
      description: `Created deal: ${dealName}`,
    }),

  dealUpdated: (req: Request, dealId: string, dealName: string, changes?: Record<string, any>) =>
    logFromRequest(req, AUDIT_ACTIONS.DEAL_UPDATED, {
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: dealId,
      resourceName: dealName,
      metadata: { changes },
    }),

  dealDeleted: (req: Request, dealId: string, dealName: string) =>
    logFromRequest(req, AUDIT_ACTIONS.DEAL_DELETED, {
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: dealId,
      resourceName: dealName,
      description: `Deleted deal: ${dealName}`,
      severity: SEVERITY.WARNING,
    }),

  // Documents
  documentUploaded: (req: Request, docId: string, docName: string, dealId?: string) =>
    logFromRequest(req, AUDIT_ACTIONS.DOCUMENT_UPLOADED, {
      resourceType: RESOURCE_TYPES.DOCUMENT,
      resourceId: docId,
      resourceName: docName,
      metadata: { dealId },
    }),

  documentDownloaded: (
    req: Request,
    docId: string,
    docName: string,
    extra?: Record<string, unknown>,
  ) =>
    logFromRequest(req, AUDIT_ACTIONS.DOCUMENT_DOWNLOADED, {
      resourceType: RESOURCE_TYPES.DOCUMENT,
      resourceId: docId,
      resourceName: docName,
      metadata: extra,
    }),

  documentDeleted: (req: Request, docId: string, docName: string) =>
    logFromRequest(req, AUDIT_ACTIONS.DOCUMENT_DELETED, {
      resourceType: RESOURCE_TYPES.DOCUMENT,
      resourceId: docId,
      resourceName: docName,
      severity: SEVERITY.WARNING,
    }),

  // Memos
  memoCreated: (req: Request, memoId: string, memoTitle: string) =>
    logFromRequest(req, AUDIT_ACTIONS.MEMO_CREATED, {
      resourceType: RESOURCE_TYPES.MEMO,
      resourceId: memoId,
      resourceName: memoTitle,
    }),

  memoDeleted: (req: Request, memoId: string, memoTitle: string) =>
    logFromRequest(req, AUDIT_ACTIONS.MEMO_DELETED, {
      resourceType: RESOURCE_TYPES.MEMO,
      resourceId: memoId,
      resourceName: memoTitle,
      severity: SEVERITY.WARNING,
    }),

  // Users
  userCreated: (req: Request, targetUserId: string, email: string) =>
    logFromRequest(req, AUDIT_ACTIONS.USER_CREATED, {
      resourceType: RESOURCE_TYPES.USER,
      resourceId: targetUserId,
      resourceName: email,
    }),

  userUpdated: (req: Request, targetUserId: string, email: string, changes?: Record<string, any>) =>
    logFromRequest(req, AUDIT_ACTIONS.USER_UPDATED, {
      resourceType: RESOURCE_TYPES.USER,
      resourceId: targetUserId,
      resourceName: email,
      metadata: { changes },
      severity: changes?.roleChanged ? SEVERITY.WARNING : SEVERITY.INFO,
    }),

  userDeleted: (req: Request, targetUserId: string, email: string) =>
    logFromRequest(req, AUDIT_ACTIONS.USER_DELETED, {
      resourceType: RESOURCE_TYPES.USER,
      resourceId: targetUserId,
      resourceName: email,
      severity: SEVERITY.WARNING,
    }),

  // AI operations
  aiChat: (req: Request, context?: string) =>
    logFromRequest(req, AUDIT_ACTIONS.AI_CHAT, {
      metadata: { context },
    }),

  aiIngest: (req: Request, fileName: string, resultDealId?: string) =>
    logFromRequest(req, AUDIT_ACTIONS.AI_INGEST, {
      resourceType: RESOURCE_TYPES.DEAL,
      resourceId: resultDealId,
      resourceName: fileName,
    }),

  aiGenerate: (req: Request, sectionName: string, memoId?: string) =>
    logFromRequest(req, AUDIT_ACTIONS.AI_GENERATE, {
      resourceType: RESOURCE_TYPES.MEMO,
      resourceId: memoId,
      resourceName: sectionName,
      description: `AI generated content for section: ${sectionName}`,
    }),

  // Generic log method for custom events
  log: (req: Request, options: {
    action: string;
    resourceType?: string;
    resourceId?: string;
    resourceName?: string;
    userId?: string;
    metadata?: Record<string, any>;
    description?: string;
    severity?: SeverityLevel;
  }) =>
    logFromRequest(req, options.action as AuditAction, {
      resourceType: options.resourceType as ResourceType,
      resourceId: options.resourceId,
      resourceName: options.resourceName,
      description: options.description,
      metadata: options.metadata,
      severity: options.severity,
    }),
};

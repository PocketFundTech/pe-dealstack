import { Request, Response, NextFunction } from 'express';
import { log } from '../utils/logger.js';

/**
 * Role-Based Access Control (RBAC) System
 *
 * Role Hierarchy (highest to lowest):
 * 1. ADMIN - Full system access
 * 2. PARTNER - Senior partner/MD level
 * 3. PRINCIPAL - Principal level
 * 4. VP - Vice President level
 * 5. ASSOCIATE - Associate level
 * 6. ANALYST - Analyst level
 * 7. VIEWER - Read-only access
 */

// User roles in order of privilege (highest first)
export const ROLES = {
  ADMIN: 'admin',
  PARTNER: 'partner',
  PRINCIPAL: 'principal',
  VP: 'vp',
  ASSOCIATE: 'associate',
  ANALYST: 'analyst',
  VIEWER: 'viewer',
  OPS: 'ops', // Operations/Admin staff
  MEMBER: 'member', // Default role for new users
} as const;

export type UserRole = typeof ROLES[keyof typeof ROLES];

// Role hierarchy - higher index = lower privilege
const ROLE_HIERARCHY: UserRole[] = [
  ROLES.ADMIN,
  ROLES.PARTNER,
  ROLES.PRINCIPAL,
  ROLES.VP,
  ROLES.ASSOCIATE,
  ROLES.MEMBER,
  ROLES.ANALYST,
  ROLES.OPS,
  ROLES.VIEWER,
];

// Permission definitions
export const PERMISSIONS = {
  // Deal permissions
  DEAL_VIEW: 'deal:view',
  DEAL_CREATE: 'deal:create',
  DEAL_EDIT: 'deal:edit',
  DEAL_DELETE: 'deal:delete',
  DEAL_ASSIGN: 'deal:assign',
  DEAL_EXPORT: 'deal:export',

  // Task permissions. Creating a task for yourself is a personal to-do and
  // needs only TASK_CREATE; assigning work to someone else needs DEAL_ASSIGN.
  TASK_CREATE: 'task:create',

  // Document permissions
  DOC_VIEW: 'doc:view',
  DOC_UPLOAD: 'doc:upload',
  DOC_DELETE: 'doc:delete',
  DOC_DOWNLOAD: 'doc:download',

  // Memo permissions
  MEMO_VIEW: 'memo:view',
  MEMO_CREATE: 'memo:create',
  MEMO_EDIT: 'memo:edit',
  MEMO_DELETE: 'memo:delete',
  MEMO_APPROVE: 'memo:approve',
  MEMO_EXPORT: 'memo:export',

  // User management permissions
  USER_VIEW: 'user:view',
  USER_CREATE: 'user:create',
  USER_EDIT: 'user:edit',
  USER_DELETE: 'user:delete',
  USER_INVITE: 'user:invite',

  // AI permissions
  AI_CHAT: 'ai:chat',
  AI_GENERATE: 'ai:generate',
  AI_INGEST: 'ai:ingest',

  // Admin permissions
  ADMIN_SETTINGS: 'admin:settings',
  ADMIN_AUDIT: 'admin:audit',
  ADMIN_BILLING: 'admin:billing',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

// Role-to-permission mapping
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS), // Admin has all permissions

  [ROLES.PARTNER]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DEAL_DELETE, PERMISSIONS.DEAL_ASSIGN, PERMISSIONS.DEAL_EXPORT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DELETE, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.MEMO_DELETE, PERMISSIONS.MEMO_APPROVE, PERMISSIONS.MEMO_EXPORT,
    PERMISSIONS.USER_VIEW, PERMISSIONS.USER_INVITE,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
    PERMISSIONS.ADMIN_AUDIT,
  ],

  [ROLES.PRINCIPAL]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DEAL_ASSIGN, PERMISSIONS.DEAL_EXPORT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DELETE, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.MEMO_APPROVE, PERMISSIONS.MEMO_EXPORT,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
  ],

  [ROLES.VP]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DEAL_EXPORT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT, PERMISSIONS.MEMO_EXPORT,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
  ],

  [ROLES.ASSOCIATE]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
  ],

  [ROLES.MEMBER]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DEAL_DELETE, PERMISSIONS.DEAL_EXPORT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DELETE, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
  ],

  [ROLES.ANALYST]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, // Allow analysts to create deals/data rooms
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.USER_VIEW,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE,
  ],

  [ROLES.OPS]: [
    PERMISSIONS.TASK_CREATE,
    PERMISSIONS.DEAL_VIEW, PERMISSIONS.DEAL_CREATE, PERMISSIONS.DEAL_EDIT,
    PERMISSIONS.DEAL_DELETE, PERMISSIONS.DEAL_ASSIGN, PERMISSIONS.DEAL_EXPORT,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_UPLOAD, PERMISSIONS.DOC_DELETE, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW, PERMISSIONS.MEMO_CREATE, PERMISSIONS.MEMO_EDIT,
    PERMISSIONS.USER_VIEW, PERMISSIONS.USER_CREATE, PERMISSIONS.USER_EDIT, PERMISSIONS.USER_INVITE,
    PERMISSIONS.AI_CHAT, PERMISSIONS.AI_GENERATE, PERMISSIONS.AI_INGEST,
    PERMISSIONS.ADMIN_SETTINGS, PERMISSIONS.ADMIN_AUDIT,
  ],

  [ROLES.VIEWER]: [
    PERMISSIONS.DEAL_VIEW,
    PERMISSIONS.DOC_VIEW, PERMISSIONS.DOC_DOWNLOAD,
    PERMISSIONS.MEMO_VIEW,
    PERMISSIONS.USER_VIEW,
  ],
};

/**
 * Check if a user has a specific permission
 */
export function hasPermission(userRole: UserRole | string | undefined, permission: Permission): boolean {
  if (!userRole) return false;
  const role = userRole.toLowerCase() as UserRole;
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.includes(permission) : false;
}

/**
 * Check if a user has ANY of the specified permissions
 */
export function hasAnyPermission(userRole: UserRole | string | undefined, permissions: Permission[]): boolean {
  return permissions.some(p => hasPermission(userRole, p));
}

/**
 * Check if a user has ALL of the specified permissions
 */
export function hasAllPermissions(userRole: UserRole | string | undefined, permissions: Permission[]): boolean {
  return permissions.every(p => hasPermission(userRole, p));
}

/**
 * Check if a role is at or above a minimum level
 */
export function isRoleAtLeast(userRole: UserRole | string | undefined, minimumRole: UserRole): boolean {
  if (!userRole) return false;
  const role = userRole.toLowerCase() as UserRole;
  const userIndex = ROLE_HIERARCHY.indexOf(role);
  const minIndex = ROLE_HIERARCHY.indexOf(minimumRole);
  // Lower index = higher privilege
  return userIndex !== -1 && userIndex <= minIndex;
}

/**
 * Middleware: Require specific permission(s)
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const userRole = req.user.role;
    const hasPerms = hasAnyPermission(userRole, permissions);

    if (!hasPerms) {
      log.debug('RBAC permission denied', { userId: req.user.id, userRole, permissions });
      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient permissions. Required: ${permissions.join(' or ')}`,
        required: permissions,
        userRole: userRole || 'none',
      });
      return;
    }

    next();
  };
}

/**
 * Middleware: Require all specified permissions
 */
export function requireAllPermissions(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const userRole = req.user.role;

    if (!hasAllPermissions(userRole, permissions)) {
      const missing = permissions.filter(p => !hasPermission(userRole, p));
      res.status(403).json({
        error: 'Forbidden',
        message: `Missing required permissions: ${missing.join(', ')}`,
        missing,
        userRole: userRole || 'none',
      });
      return;
    }

    next();
  };
}

/**
 * Middleware: Require minimum role level
 */
export function requireMinimumRole(minimumRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const userRole = req.user.role;

    if (!isRoleAtLeast(userRole, minimumRole)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `This action requires at least ${minimumRole} role`,
        required: minimumRole,
        userRole: userRole || 'none',
      });
      return;
    }

    next();
  };
}

/**
 * Get all permissions for a role
 */
export function getPermissionsForRole(role: UserRole | string): Permission[] {
  const normalizedRole = role.toLowerCase() as UserRole;
  return ROLE_PERMISSIONS[normalizedRole] || [];
}

/**
 * Validate if a string is a valid role
 */
export function isValidRole(role: string): role is UserRole {
  return Object.values(ROLES).includes(role.toLowerCase() as UserRole);
}

import { Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getCachedOrgMfa, setCachedOrgMfa } from './authContextCache.js';

// User type for authenticated requests
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  firmName?: string;
  organizationId?: string;
  role: string;
  user_metadata?: Record<string, unknown>;
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authentication middleware that verifies Supabase JWT tokens
 * Extracts user information and attaches it to the request
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Request already authenticated by apiKeyMiddleware — skip JWT auth.
    if (req.apiKey) {
      return next();
    }

    // Get the Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      log.debug('Auth failed: no authorization header', { method: req.method, url: req.originalUrl });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No authorization header provided',
      });
      return;
    }

    // Check for Bearer token
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Use Bearer token.',
      });
      return;
    }

    // Extract the token
    const token = authHeader.substring(7);

    if (!token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No token provided',
      });
      return;
    }

    // Verify the token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      log.warn('Auth token validation failed', {
        error: error?.message || 'User not found',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        url: req.originalUrl,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired token',
      });
      return;
    }

    // Attach user to request
    // Default to 'MEMBER' role if no role is set in user_metadata
    req.user = {
      id: user.id,
      email: user.email || '',
      name: user.user_metadata?.full_name as string | undefined,
      firmName: user.user_metadata?.firm_name as string | undefined,
      role: (user.user_metadata?.role as string) || 'MEMBER',
      user_metadata: user.user_metadata as Record<string, unknown> | undefined,
    };

    next();
  } catch (error) {
    log.error('Auth middleware error', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if token is provided, but doesn't require it
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      if (token) {
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (!error && user) {
          req.user = {
            id: user.id,
            email: user.email || '',
            name: user.user_metadata?.full_name as string | undefined,
            firmName: user.user_metadata?.firm_name as string | undefined,
            role: (user.user_metadata?.role as string) || 'MEMBER',
            user_metadata: user.user_metadata as Record<string, unknown> | undefined,
          };
        }
      }
    }

    next();
  } catch (error) {
    // Silently continue without user attached
    next();
  }
}

// Paths that bypass org-level MFA enforcement so users can still enroll
// their factor, manage sessions, and read their own org/user state.
// These are checked by `req.path.startsWith(prefix)`.
const MFA_BYPASS_PATH_PREFIXES: string[] = [
  '/auth/',           // login/logout/MFA enrollment
  '/api/auth/',
  '/organizations/me',
  '/api/organizations/me',
  '/users/me',
  '/api/users/me',
];

async function userHasVerifiedMfa(userId: string): Promise<boolean> {
  try {
    // Use Supabase admin client to list factors for this user.
    // The exact API may vary by SDK version — adjust if needed.
    const adminAuth: any = (supabase as any).auth?.admin;
    if (!adminAuth?.mfa?.listFactors) return false;
    const { data, error } = await adminAuth.mfa.listFactors({ userId });
    if (error) return false;
    const factors = (data?.factors || []) as Array<{ status?: string }>;
    return factors.some((f) => f.status === 'verified');
  } catch {
    return false;
  }
}

/**
 * Org-level MFA enforcement middleware.
 * If the user's organization has `requireMFA = true`, blocks API access for
 * users without a verified MFA factor. Bypasses paths needed for enrollment
 * and self-service so users can still get into compliance.
 * Must run after authMiddleware (and ideally orgMiddleware).
 */
export const enforceOrgMfaMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // API keys are machine credentials — org MFA policy applies to humans.
    if (req.apiKey) {
      next();
      return;
    }

    const user = req.user;
    if (!user) {
      next();
      return;
    }

    // Use originalUrl so the bypass list works regardless of where this
    // middleware is mounted in the Express tree (req.path strips the mount
    // prefix; originalUrl preserves the full request path). Strip query string.
    const fullPath = (req.originalUrl || req.url || '').split('?')[0] || '';
    if (MFA_BYPASS_PATH_PREFIXES.some((p) => fullPath.startsWith(p))) {
      next();
      return;
    }

    const orgId = user.organizationId;
    if (!orgId) {
      next();
      return;
    }

    // Short-TTL cache: requireMFA is looked up on every request, but changes
    // rarely. On a miss we hit the DB and cache the result (see authContextCache).
    let requireMFA = getCachedOrgMfa(orgId);
    if (requireMFA === undefined) {
      const { data: org, error: orgErr } = await supabase
        .from('Organization')
        .select('requireMFA')
        .eq('id', orgId)
        .single();

      if (orgErr || !org) {
        next(); // fail-open on transient lookup error (not cached)
        return;
      }
      requireMFA = !!org.requireMFA;
      setCachedOrgMfa(orgId, requireMFA);
    }

    if (!requireMFA) {
      next();
      return;
    }

    const hasMfa = await userHasVerifiedMfa(user.id);
    if (hasMfa) {
      next();
      return;
    }

    res.status(403).json({
      error: 'Two-factor authentication is required by your organization',
      code: 'MFA_REQUIRED',
    });
    return;
  } catch (err) {
    log.error('enforceOrgMfaMiddleware error', err as any);
    next(); // fail-open on errors — don't lock users out on transient bugs
  }
};

/**
 * Role-based access control middleware
 * Must be used after authMiddleware
 * @param allowedRoles - Array of roles that can access the route
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const userRole = req.user.role;

    if (!userRole || !allowedRoles.includes(userRole)) {
      res.status(403).json({
        error: 'Forbidden',
        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`,
      });
      return;
    }

    next();
  };
}

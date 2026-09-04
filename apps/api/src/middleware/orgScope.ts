import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { findOrCreateUser } from '../services/userService.js';
import { getCachedUserContext, setCachedUserContext } from './authContextCache.js';

/** Build a slug suffix using a UUID fragment so same-millisecond inserts don't collide. */
function buildSlug(base: string): string {
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * Organization scoping middleware.
 * Must run after authMiddleware.
 * Resolves the current user's organizationId from the User table.
 * If User record doesn't exist yet (first request after signup),
 * auto-creates User + Organization to eliminate race conditions.
 */
export async function orgMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      return next();
    }

    // Fast path: a warm lambda serves the User→{org,role} lookup from a
    // short-TTL cache instead of a DB round trip on every request. Only
    // populated (below) for users who already have an organization, so a
    // cache hit always carries a usable organizationId.
    const cached = getCachedUserContext(req.user.id);
    if (cached?.organizationId) {
      if (cached.role) req.user.role = cached.role;
      req.user.organizationId = cached.organizationId;
      return next();
    }

    // Look up the User record by authId to get organizationId.
    // Also pull `role` — the JWT's user_metadata.role defaults to 'MEMBER' for
    // everyone (auth middleware sets it from Supabase user_metadata, which is
    // rarely populated). The User.role column carries the canonical value
    // (set by findOrCreateUser, updated by invitation/role-change flows).
    // Override req.user.role here once so every downstream admin check sees
    // the table value.
    const { data: userRecord, error } = await supabase
      .from('User')
      .select('id, organizationId, role')
      .eq('authId', req.user.id)
      .single();

    if (userRecord?.role && req.user) {
      req.user.role = String(userRecord.role);
    }

    if (error && error.code === 'PGRST116') {
      // User record doesn't exist yet (first request after signup).
      // Auto-create User + Organization to avoid race conditions
      // where parallel API calls hit before /api/users/me creates the record.
      try {
        const newUser = await findOrCreateUser(req.user);
        if (newUser?.organizationId) {
          req.user.organizationId = newUser.organizationId;
        }
      } catch (createErr) {
        log.error('Org middleware: auto-create user failed', createErr);
      }
      return next();
    }

    if (error) {
      log.error('Org middleware: failed to resolve user', error);
    }

    if (userRecord?.organizationId) {
      req.user.organizationId = userRecord.organizationId;
      // Cache for subsequent warm requests (short TTL — see authContextCache).
      setCachedUserContext(req.user.id, {
        userId: userRecord.id,
        organizationId: userRecord.organizationId,
        role: userRecord.role ? String(userRecord.role) : null,
      });
    } else if (userRecord && !userRecord.organizationId) {
      // User exists but has no Organization — find existing or create one
      try {
        const firmName = req.user.firmName || req.user.email?.split('@')[0] || 'My Firm';
        const slug = firmName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 100) || 'org';

        // SECURITY: never attach to an existing org by name — firmName is
        // user-controlled, so a name match would let a user join another
        // tenant's org. Always create a fresh org for a user who has none.
        const uniqueSlug = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const { data: newOrg } = await supabase
          .from('Organization')
          .insert({ name: firmName, slug: uniqueSlug })
          .select('id')
          .single();

        if (newOrg) {
          // Race guard: re-fetch User by authId — a parallel request may have
          // already set organizationId. If so, prefer the existing org and
          // discard the one we just created (it will be orphaned).
          const { data: refetched } = await supabase
            .from('User')
            .select('id, organizationId')
            .eq('authId', req.user.id)
            .single();

          if (refetched?.organizationId && refetched.organizationId !== newOrg.id) {
            log.warn('Org middleware: race detected — parallel request set organizationId, using existing', {
              userId: userRecord.id,
              parallelOrgId: refetched.organizationId,
              discardedOrgId: newOrg.id,
            });
            req.user.organizationId = refetched.organizationId;
          } else {
            await supabase
              .from('User')
              .update({ organizationId: newOrg.id })
              .eq('id', userRecord.id);

            req.user.organizationId = newOrg.id;
            log.info('Org middleware: auto-created org for user without one', { userId: userRecord.id, orgId: newOrg.id });
          }
        }
      } catch (createErr) {
        log.error('Org middleware: failed to auto-create org', createErr);
      }
    }

    next();
  } catch (error) {
    log.error('Org middleware error', error);
    next();
  }
}

/**
 * Middleware that REQUIRES organizationId to be resolved.
 * Returns 403 if user has no organization.
 * Use for routes that must be org-scoped.
 */
export function requireOrg(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user?.organizationId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'You must belong to an organization to access this resource',
    });
    return;
  }
  next();
}

/**
 * Helper to get orgId from request. Throws if not available.
 */
export function getOrgId(req: Request): string {
  const orgId = req.user?.organizationId;
  if (!orgId) {
    throw new Error('Organization ID not available');
  }
  return orgId;
}

/**
 * Middleware factory that restricts a router to a single organization,
 * identified by slug. Use for features gated to one specific tenant (e.g.
 * the Outreach pipeline board, currently Cicero Capital only) rather than
 * gated by role.
 *
 * Must run after orgMiddleware (reads req.user.organizationId, which
 * orgMiddleware attaches) — mount it after authMiddleware, orgMiddleware,
 * enforceOrgMfaMiddleware, matching the other org-scoped routers in app.ts.
 *
 * req.user carries organizationId but NOT the org's slug (see
 * types/express.d.ts) — orgMiddleware never looks it up — so this does one
 * extra Organization lookup per request.
 *
 * SECURITY: this is a real authorization boundary, not a UX nicety — per
 * this project's trust model (see rls-hardening-migration.sql), RLS is
 * deny-all and Express is where access control actually happens. Unlike
 * enforceOrgMfaMiddleware (which fails OPEN on a transient lookup error,
 * because MFA is a soft policy), this fails CLOSED: any missing org, lookup
 * error, or slug mismatch returns 403. Never let a lookup failure fall
 * through to next().
 */
export function requireOrgSlug(slugOrSlugs: string | string[]) {
  const allowedSlugs = Array.isArray(slugOrSlugs) ? slugOrSlugs : [slugOrSlugs];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const orgId = req.user?.organizationId;
    if (!orgId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You must belong to an organization to access this resource',
      });
      return;
    }

    try {
      const { data: org, error } = await supabase
        .from('Organization')
        .select('slug')
        .eq('id', orgId)
        .single();

      if (error || !org || !allowedSlugs.includes(org.slug)) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'This resource is not available to your organization',
        });
        return;
      }

      next();
    } catch (err) {
      log.error('requireOrgSlug middleware error', err);
      // Fail closed — see SECURITY note above.
      res.status(403).json({
        error: 'Forbidden',
        message: 'This resource is not available to your organization',
      });
    }
  };
}

/** Gates a router to the Cicero Capital org (Organization.slug === 'cicero-capital'). */
export const requireCiceroCapital = requireOrgSlug('cicero-capital');

/**
 * Verify a deal belongs to the user's organization.
 * Use in deal-child routes (documents, folders, activities, financials).
 * Returns the deal record or null if not found / not in org.
 */
export async function verifyDealAccess(dealId: string, orgId: string) {
  const { data } = await supabase
    .from('Deal')
    .select('id, organizationId')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .single();
  return data;
}

/**
 * Verify a contact belongs to the user's organization.
 * Returns the contact record or null if not found / not in org.
 */
export async function verifyContactAccess(contactId: string, orgId: string) {
  const { data } = await supabase
    .from('Contact')
    .select('id, organizationId')
    .eq('id', contactId)
    .eq('organizationId', orgId)
    .single();
  return data;
}

/**
 * Verify a document belongs to a deal in the user's organization.
 * Resolves ownership through Document → Deal → organizationId.
 * Returns the document record or null if not found / not in org.
 */
export async function verifyDocumentAccess(documentId: string, orgId: string) {
  const { data: doc } = await supabase
    .from('Document')
    .select('id, dealId')
    .eq('id', documentId)
    .single();
  if (!doc?.dealId) return null;
  const deal = await verifyDealAccess(doc.dealId, orgId);
  return deal ? doc : null;
}

/**
 * Verify a folder belongs to a deal in the user's organization.
 * Resolves ownership through Folder → Deal → organizationId.
 * Returns the folder record or null if not found / not in org.
 */
export async function verifyFolderAccess(folderId: string, orgId: string) {
  const { data: folder } = await supabase
    .from('Folder')
    .select('id, dealId')
    .eq('id', folderId)
    .single();
  if (!folder?.dealId) return null;
  const deal = await verifyDealAccess(folder.dealId, orgId);
  return deal ? folder : null;
}

/**
 * Verify a conversation belongs to a deal in the user's organization.
 * Resolves ownership through Conversation → Deal → organizationId.
 * Returns the conversation record or null if not found / not in org.
 */
export async function verifyConversationAccess(conversationId: string, orgId: string) {
  const { data: conv } = await supabase
    .from('Conversation')
    .select('id, dealId')
    .eq('id', conversationId)
    .single();
  if (!conv?.dealId) return null;
  const deal = await verifyDealAccess(conv.dealId, orgId);
  return deal ? conv : null;
}

/**
 * Verify an Outreach pipeline stage belongs to the user's organization.
 * Use before writing an OutreachContact.stageId (create or move) so a
 * guessed/foreign stage id can't be used to file a contact under another
 * org's stage.
 * Returns the stage record or null if not found / not in org.
 */
export async function verifyOutreachStageAccess(stageId: string, orgId: string) {
  const { data } = await supabase
    .from('OutreachStage')
    .select('id, organizationId')
    .eq('id', stageId)
    .eq('organizationId', orgId)
    .single();
  return data;
}

/**
 * Verify an Outreach contact belongs to the user's organization.
 * Returns the contact record or null if not found / not in org.
 */
export async function verifyOutreachContactAccess(contactId: string, orgId: string) {
  const { data } = await supabase
    .from('OutreachContact')
    .select('id, organizationId, stageId')
    .eq('id', contactId)
    .eq('organizationId', orgId)
    .single();
  return data;
}

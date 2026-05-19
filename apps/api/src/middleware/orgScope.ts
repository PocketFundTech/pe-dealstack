import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { findOrCreateUser } from '../services/userService.js';

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

    // Look up the User record by authId to get organizationId
    const { data: userRecord, error } = await supabase
      .from('User')
      .select('id, organizationId')
      .eq('authId', req.user.id)
      .single();

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
    } else if (userRecord && !userRecord.organizationId) {
      // User exists but has no Organization — find existing or create one
      try {
        const firmName = req.user.firmName || req.user.email?.split('@')[0] || 'My Firm';
        const slugBase = firmName.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 100);

        // First try to find an existing org with same name (might exist from a previous failed attempt)
        let newOrg: { id: string } | null = null;
        const { data: existingOrg } = await supabase
          .from('Organization')
          .select('id')
          .eq('name', firmName)
          .single();

        if (existingOrg) {
          newOrg = existingOrg;
        } else {
          // Attempt insert with a UUID-suffixed slug. Retry once on unique-slug
          // collision (Postgres 23505) — astronomically unlikely but cheap to handle.
          let createdOrg: { id: string } | null = null;
          let insertErr: { code?: string } | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const res = await supabase
              .from('Organization')
              .insert({ name: firmName, slug: buildSlug(slugBase) })
              .select('id')
              .single();
            createdOrg = (res.data as { id: string } | null) ?? null;
            insertErr = (res.error as { code?: string } | null) ?? null;
            if (createdOrg) break;
            if (insertErr?.code !== '23505') break; // non-unique-violation: don't retry
            log.warn('Org middleware: slug collision, retrying with new slug', { attempt });
          }
          if (!createdOrg && insertErr) {
            log.error('Org middleware: failed to create org', insertErr);
          }
          newOrg = createdOrg;
        }

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

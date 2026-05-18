/**
 * Global Express type augmentation.
 *
 * Declares `Request.user` as the canonical authenticated-user shape. This
 * file is the single source of truth — without it every route handler has
 * to either cast `(req as any).user.id` or type the handler as `req: any`
 * just to read fields the auth middleware has already attached.
 *
 * The shape mirrors what `authMiddleware` (`middleware/auth.ts`) attaches
 * on success and what `orgMiddleware` (`middleware/orgScope.ts`) later
 * augments with `organizationId`. Don't add fields here that the
 * middleware doesn't actually set — if a field isn't attached at runtime,
 * typing it as required would be a lie.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 6 Task 6.1
 */

import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        // Supabase auth user UUID. Always present once authMiddleware succeeds.
        id: string;

        // Email from the Supabase auth user record. Always present (may be
        // an empty string if the auth user has no email on file).
        email: string;

        // Display name from user_metadata.full_name. Optional — not every
        // user has set one.
        name?: string;

        // Firm name from user_metadata.firm_name. Optional — used to
        // bootstrap the Organization record on first login.
        firmName?: string;

        // Internal Organization.id, resolved by orgMiddleware from the
        // User table. Absent until orgMiddleware has run (or if the user
        // has no Organization).
        organizationId?: string;

        // Role string from user_metadata.role, defaulted to 'MEMBER' by
        // authMiddleware. Kept as `string` (not a union) because the
        // auth-refactor task that narrows this hasn't shipped yet.
        role: string;

        // Raw Supabase user_metadata. Useful for downstream code that
        // reads custom fields not promoted into the typed shape above.
        user_metadata?: Record<string, unknown>;
      };
    }
  }
}

// Make this a module so the `declare global` block is processed.
export {};

// ─── Authenticated account-security emails ─────────────────────────
// Mounted at /api/account/security WITH authMiddleware only (no org/MFA
// gates — a user must be able to reach this even mid-MFA-lockout). Both
// endpoints read the acting user from req.user (attached by
// authMiddleware), never from the request body.
//
// PLACEHOLDER — filled in by the password-changed and new-device-login
// email builds.

import { Router } from 'express';

const router = Router();

export default router;

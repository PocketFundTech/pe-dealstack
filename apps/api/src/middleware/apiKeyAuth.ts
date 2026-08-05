// ─── API key authentication ────────────────────────────────────────
// Alternative auth path for machine callers (agents, reporting scripts).
// Mounted on /api BEFORE the JWT middleware chain. When the x-api-key
// header is present it fully authenticates the request and the JWT
// middlewares (auth/org/MFA/usage) step aside via the req.apiKey guard.
//
// Read-only by design: keys with only the 'read' scope are rejected on
// any non-GET/HEAD/OPTIONS method. RBAC is additionally enforced by
// giving key requests the VIEWER role, whose permission set is
// view/download only.

import { Request, Response, NextFunction } from 'express';
import { verifyApiKey, API_KEY_HEADER, type ApiKeyRecord } from '../services/apiKeyService.js';
import { log } from '../utils/logger.js';

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function apiKeyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawKey = req.headers[API_KEY_HEADER];
    if (!rawKey || typeof rawKey !== 'string') {
      return next(); // no key presented — fall through to JWT auth
    }

    const record = await verifyApiKey(rawKey);
    if (!record) {
      log.warn('API key auth failed', { ip: req.ip, url: req.originalUrl });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key',
      });
      return;
    }

    if (!record.scopes.includes('write') && !READ_METHODS.has(req.method)) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'This API key is read-only (GET requests only)',
      });
      return;
    }

    req.apiKey = record;
    // Synthesize a request user so downstream org scoping, RBAC, and audit
    // logging work unchanged. Attribution goes to the key's creator (audit
    // rows carry the api-key marker in userEmail); VIEWER restricts RBAC
    // to read permissions.
    req.user = {
      id: record.createdBy ?? record.id,
      email: `api-key:${record.name}`,
      role: 'VIEWER',
      organizationId: record.organizationId,
    };

    next();
  } catch (error) {
    log.error('API key middleware error', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'API key authentication failed',
    });
  }
}

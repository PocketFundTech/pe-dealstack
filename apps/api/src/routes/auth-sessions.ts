import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  logAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES,
  SEVERITY,
} from '../services/auditLog.js';

const router = Router();

/**
 * Helper — fetch sessions for a user using whichever Supabase API is available.
 * Returns empty list (not error) if no path works, so the UI degrades gracefully.
 */
async function fetchUserSessions(userId: string): Promise<any[]> {
  const adminAuth: any = (supabase as any).auth?.admin;

  // Path 1: official admin API (not present in @supabase/auth-js 2.101.x)
  if (adminAuth?.listUserSessions) {
    try {
      const { data, error } = await adminAuth.listUserSessions(userId);
      if (!error && data) {
        return data.sessions || data || [];
      }
      log.warn('listUserSessions returned error', error as any);
    } catch (err) {
      log.warn('listUserSessions threw', err as any);
    }
  }

  // Path 2: query the auth.sessions table directly via service-role client.
  // Requires `auth` to be in PostgREST's exposed schemas. If it isn't,
  // this throws — we swallow and return an empty list.
  try {
    const client: any = supabase;
    const builder =
      typeof client.schema === 'function'
        ? client.schema('auth').from('sessions')
        : client.from('auth.sessions');
    const { data, error } = await builder
      .select('id, user_id, created_at, updated_at, user_agent, ip')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (!error && Array.isArray(data)) return data;
    if (error) log.warn('auth.sessions select error', error as any);
  } catch (err) {
    log.warn('auth.sessions fallback query failed', err as any);
  }

  return [];
}

/**
 * GET /api/auth/sessions — list current user's active sessions.
 * Always 200 with `sessions: []` on degraded environments.
 */
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const sessions = await fetchUserSessions(user.id);
    const currentSessionId = (req as any).sessionId || null;

    const mapped = sessions.map((s: any) => ({
      id: s.id,
      lastActiveAt: s.updated_at || s.created_at || null,
      createdAt: s.created_at || null,
      userAgent: s.user_agent || null,
      ipAddress: s.ip || null,
      current: !!currentSessionId && s.id === currentSessionId,
    }));

    res.json({ sessions: mapped });
  } catch (err) {
    log.error('sessions list error', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * DELETE /api/auth/sessions/:id — revoke one of the user's own sessions.
 * Verifies ownership before revoking. Returns 501 if no revocation path
 * is available in this environment.
 */
router.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user?.id) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Missing session id' });
      return;
    }

    // Verify the session belongs to this user (defends against id-guessing).
    const ownedSessions = await fetchUserSessions(user.id);
    const target = ownedSessions.find((s: any) => s.id === id);
    if (!target) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    let revoked = false;
    const adminAuth: any = (supabase as any).auth?.admin;

    // Path 1: admin.signOut — historical SDKs accepted a session id.
    // Current SDK accepts a JWT; calling it with an id will likely fail
    // server-side, but we attempt it harmlessly and detect non-success.
    if (adminAuth?.signOut) {
      try {
        const result: any = await adminAuth.signOut(id);
        if (result && !result.error) {
          revoked = true;
        } else if (result?.error) {
          log.warn('admin.signOut returned error', result.error);
        }
      } catch (err) {
        log.warn('admin.signOut threw', err as any);
      }
    }

    // Path 2: direct delete on auth.sessions.
    if (!revoked) {
      try {
        const client: any = supabase;
        const builder =
          typeof client.schema === 'function'
            ? client.schema('auth').from('sessions')
            : client.from('auth.sessions');
        const { error } = await builder.delete().eq('id', id).eq('user_id', user.id);
        if (!error) {
          revoked = true;
        } else {
          log.warn('auth.sessions delete error', error as any);
        }
      } catch (err) {
        log.warn('auth.sessions delete threw', err as any);
      }
    }

    if (!revoked) {
      res.status(501).json({
        error: 'Session revocation not available in this environment',
      });
      return;
    }

    try {
      await logAuditEvent(
        {
          userId: user.id,
          userEmail: user.email,
          userRole: user.role,
          organizationId: user.organizationId,
          action: AUDIT_ACTIONS.LOGOUT,
          resourceType: RESOURCE_TYPES.USER,
          resourceId: user.id,
          severity: SEVERITY.INFO,
          metadata: { sessionId: id, source: 'manual_revoke' },
        },
        req
      );
    } catch (auditErr) {
      log.warn('audit log write failed for session revoke', auditErr as any);
    }

    res.json({ success: true });
  } catch (err) {
    log.error('session revoke error', err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

export default router;

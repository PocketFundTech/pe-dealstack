import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePermission, PERMISSIONS } from '../middleware/rbac.js';
import { getOrgId } from '../middleware/orgScope.js';
import { invalidateUserContext } from '../middleware/authContextCache.js';
import { AuditLog } from '../services/auditLog.js';

// Sub-routers
import usersProfileRouter from './users-profile.js';

const router = Router();

// Mount sub-routers (must come first so /me routes match before /:id)
router.use('/', usersProfileRouter);

// Query parameter schemas
const usersQuerySchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
  department: z.string().max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  firmName: z.string().max(255).optional(),
  excludeUserId: z.string().uuid().optional(),
});

// Validation schemas
const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(255),
  avatar: z.string().url().optional(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional().default('MEMBER'),
  department: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  avatar: z.string().url().optional(),
  role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']).optional(),
  department: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  isActive: z.boolean().optional(),
  firmName: z.string().optional(),
});

const userNotificationsQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// GET /api/users - List users in current org
// Query params: role, department, isActive, search, excludeUserId
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req);
    const params = usersQuerySchema.parse(req.query);

    let query = supabase
      .from('User')
      .select('id, email, name, avatar, role, department, title, phone, isActive, firmName, organizationId')
      .eq('organizationId', orgId)
      .order('name', { ascending: true });

    if (params.role) {
      query = query.eq('role', params.role);
    }

    if (params.department) {
      query = query.eq('department', params.department);
    }

    if (params.isActive !== undefined) {
      query = query.eq('isActive', params.isActive === 'true');
    } else {
      query = query.eq('isActive', true);
    }

    if (params.search) {
      query = query.or(`name.ilike.%${params.search}%,email.ilike.%${params.search}%`);
    }

    if (params.excludeUserId) {
      query = query.neq('id', params.excludeUserId);
    }

    const { data: users, error } = await query;

    if (error) throw error;

    res.json(users || []);
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id - Get a single user (scoped to same org)
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: user, error } = await supabase
      .from('User')
      .select(`
        *,
        DealTeamMember (
          id,
          role,
          addedAt,
          Deal (
            id,
            name,
            stage,
            status
          )
        )
      `)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      throw error;
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
});

// POST /api/users - Create a new user (requires USER_CREATE permission)
router.post('/', requirePermission(PERMISSIONS.USER_CREATE), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = createUserSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('User')
      .select('id')
      .eq('email', validation.data.email)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const orgId = getOrgId(req);

    const { data: user, error } = await supabase
      .from('User')
      .insert({
        ...validation.data,
        organizationId: orgId,
      })
      .select()
      .single();

    if (error) throw error;

    // Audit log
    await AuditLog.userCreated(req, user.id, user.email);

    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/users/:id - Update a user (requires USER_EDIT permission)
router.patch('/:id', requirePermission(PERMISSIONS.USER_EDIT), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const validation = updateUserSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const { data: user, error } = await supabase
      .from('User')
      .update({
        ...validation.data,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      throw error;
    }

    // A role/org change must take effect immediately, not after the auth
    // cache TTL — drop this user's cached context (keyed by their auth UUID).
    if (user?.authId) {
      invalidateUserContext(user.authId as string);
    }

    // Audit log - log role changes with higher severity
    if (validation.data.role) {
      await AuditLog.userUpdated(req, user.id, user.email, { roleChanged: true, newRole: validation.data.role });
    } else {
      await AuditLog.userUpdated(req, user.id, user.email, validation.data);
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/users/:id - Soft delete a user (requires USER_DELETE permission)
router.delete('/:id', requirePermission(PERMISSIONS.USER_DELETE), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { hard } = req.query;
    const orgId = getOrgId(req);

    // Get user email before deleting for audit log (scoped to org)
    const { data: userToDelete } = await supabase
      .from('User')
      .select('email')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (hard === 'true') {
      // Hard delete - remove from database
      const { error } = await supabase
        .from('User')
        .delete()
        .eq('id', id)
        .eq('organizationId', orgId);

      if (error) throw error;
    } else {
      // Soft delete - set isActive to false
      const { error } = await supabase
        .from('User')
        .update({ isActive: false, updatedAt: new Date().toISOString() })
        .eq('id', id)
        .eq('organizationId', orgId);

      if (error) throw error;
    }

    // Audit log
    await AuditLog.userDeleted(req, id, userToDelete?.email || 'Unknown');

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id/deals - Get deals assigned to a user
router.get('/:id/deals', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // SECURITY: only expose data for a user in the caller's own organization
    const { data: targetUser } = await supabase
      .from('User').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: teamMemberships, error } = await supabase
      .from('DealTeamMember')
      .select(`
        id,
        role,
        addedAt,
        Deal (
          id,
          name,
          stage,
          status,
          industry,
          dealSize,
          irrProjected,
          Company (
            id,
            name,
            logo
          )
        )
      `)
      .eq('userId', id);

    if (error) throw error;

    res.json(teamMemberships || []);
  } catch (error) {
    next(error);
  }
});

// GET /api/users/:id/notifications - Get notifications for a user
router.get('/:id/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // SECURITY: only expose notifications for a user in the caller's own org
    const { data: targetUser } = await supabase
      .from('User').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const params = userNotificationsQuerySchema.parse(req.query);

    let query = supabase
      .from('Notification')
      .select('*')
      .eq('userId', id)
      .order('createdAt', { ascending: false });

    if (params.unreadOnly === 'true') {
      query = query.eq('isRead', false);
    }

    if (params.limit) {
      query = query.limit(params.limit);
    }

    const { data: notifications, error } = await query;

    if (error) throw error;

    res.json(notifications || []);
  } catch (error) {
    next(error);
  }
});

export default router;

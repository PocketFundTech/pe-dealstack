import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { requirePermission, PERMISSIONS } from '../middleware/rbac.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { createNotification, resolveUserId } from './notifications.js';
import { getOrgId } from '../middleware/orgScope.js';

const router = Router();

// Validation schemas
const taskQuerySchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STUCK']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assignedTo: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STUCK']).optional().default('PENDING'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional().default('MEDIUM'),
  assignedTo: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  dueDate: z.string().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STUCK']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

// ─── GET /api/tasks — List tasks ──────────────────────────────

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = taskQuerySchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: validation.error.errors });
    }

    const { status, priority, assignedTo, dealId, limit, offset } = validation.data;
    const orgId = getOrgId(req);

    let query = supabase
      .from('Task')
      .select('*, assignee:User!assignedTo(id, name, email, avatar, role), deal:Deal!dealId(id, name, stage)', { count: 'exact' })
      .eq('organizationId', orgId)
      .order('createdAt', { ascending: false });
    if (status) query = query.eq('status', status);
    if (priority) query = query.eq('priority', priority);
    if (assignedTo) query = query.eq('assignedTo', assignedTo);
    if (dealId) query = query.eq('dealId', dealId);

    query = query.range(offset, offset + limit - 1);

    const { data: tasks, error, count } = await query;

    if (error) {
      log.error('Error fetching tasks', error);
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }

    res.json({ tasks: tasks || [], count, limit, offset });
  } catch (error) {
    next(error);
  }
});

// ─── POST /api/tasks — Create task ───────────────────────────

router.post('/', requirePermission(PERMISSIONS.DEAL_ASSIGN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = createTaskSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation error', details: validation.error.errors });
    }

    const data = validation.data;
    const orgId = getOrgId(req);

    // Resolve the creator's internal user ID
    let createdBy: string | null = null;
    if (req.user?.id) {
      createdBy = await resolveUserId(req.user.id);
    }

    const { data: task, error } = await supabase
      .from('Task')
      .insert({
        title: data.title,
        description: data.description || null,
        status: data.status,
        priority: data.priority,
        assignedTo: data.assignedTo || null,
        dealId: data.dealId || null,
        dueDate: data.dueDate || null,
        createdBy,
        organizationId: orgId,
      })
      .select('*, assignee:User!assignedTo(id, name, email, avatar, role), deal:Deal!dealId(id, name, stage)')
      .single();

    if (error) {
      log.error('Error creating task', error);
      return res.status(500).json({ error: 'Failed to create task' });
    }

    // Audit log
    await AuditLog.log(req, {
      action: 'DEAL_ASSIGNED',
      resourceType: 'Deal',
      resourceId: task.id,
      metadata: { taskTitle: task.title, assignedTo: task.assignedTo },
    });

    // Notify assignee (fire-and-forget). If no assignee, notify the creator
    // instead so self-created tasks (e.g. "Review Call" scheduled with no
    // reviewer picked) still surface in the bell. When the creator is also the
    // assignee, only one notification is sent. When they differ, both get one.
    const dueLine = task.dueDate
      ? `Due: ${new Date(task.dueDate).toLocaleDateString()}`
      : undefined;
    const recipients = new Set<string>();
    if (task.assignedTo) recipients.add(task.assignedTo);
    if (recipients.size === 0 && createdBy) recipients.add(createdBy);
    for (const recipientId of recipients) {
      const isSelfCreate = recipientId === createdBy && !task.assignedTo;
      createNotification({
        userId: recipientId,
        type: 'TASK_ASSIGNED',
        title: isSelfCreate
          ? `New task created: ${task.title}`
          : `New task assigned: ${task.title}`,
        message: dueLine,
        dealId: task.dealId || undefined,
      }).catch(err => {
        log.error('Notification error (task create)', err);
        captureAgentError(err, { context: 'notification:task_create' }, 'warning');
      });
    }

    res.status(201).json(task);
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /api/tasks/:id — Update task ──────────────────────

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const validation = updateTaskSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Validation error', details: validation.error.errors });
    }

    const data = validation.data;
    const orgId = getOrgId(req);

    // Check task exists within org
    const { data: existing, error: fetchError } = await supabase
      .from('Task')
      .select('*')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const { data: task, error } = await supabase
      .from('Task')
      .update({ ...data, updatedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('organizationId', orgId)
      .select('*, assignee:User!assignedTo(id, name, email, avatar, role), deal:Deal!dealId(id, name, stage)')
      .single();

    if (error) {
      log.error('Error updating task', error);
      return res.status(500).json({ error: 'Failed to update task' });
    }

    // Notify new assignee if assignment changed
    if (data.assignedTo && data.assignedTo !== existing.assignedTo) {
      createNotification({
        userId: data.assignedTo,
        type: 'TASK_ASSIGNED',
        title: `Task assigned to you: ${task.title}`,
        dealId: task.dealId || undefined,
      }).catch(err => {
        log.error('Notification error (task reassign)', err);
        captureAgentError(err, { context: 'notification:task_reassign' }, 'warning');
      });
    }

    res.json(task);
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /api/tasks/:id — Delete task ─────────────────────

router.delete('/:id', requirePermission(PERMISSIONS.ADMIN_SETTINGS), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { error } = await supabase
      .from('Task')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) {
      log.error('Error deleting task', error);
      return res.status(500).json({ error: 'Failed to delete task' });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;

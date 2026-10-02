/**
 * QA #10 (1 Oct 2026): tasks didn't save for MEMBER / ASSOCIATE / ANALYST —
 * POST /api/tasks required DEAL_ASSIGN. Self-created tasks now need only
 * TASK_CREATE (every role but VIEWER); assigning someone else still needs
 * DEAL_ASSIGN. Uses the REAL rbac module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { hasPermission, PERMISSIONS, ROLES } from '../src/middleware/rbac.js';

const ME = '11111111-1111-1111-1111-111111111111';
const inserted: any[] = [];
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'User') {
        return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'other-user' } }) }) }) }) };
      }
      return {
        insert: (row: any) => {
          inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 'task-1', ...row }, error: null }) }) };
        },
      };
    },
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError() {} }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: async () => {} } }));
vi.mock('../src/routes/notifications.js', () => ({
  createNotification: async () => {},
  resolveUserId: async () => ME,
}));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A', verifyDealAccess: async () => true }));

async function app(role: string) {
  const { default: router } = await import('../src/routes/tasks.js');
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.user = { id: 'auth-me', organizationId: 'org-A', role }; next(); });
  a.use('/api/tasks', router);
  return a;
}

beforeEach(() => { inserted.length = 0; });

describe('TASK_CREATE is granted to every role except VIEWER', () => {
  it.each(Object.values(ROLES))('%s', (role) => {
    expect(hasPermission(role, PERMISSIONS.TASK_CREATE)).toBe(role !== ROLES.VIEWER);
  });
});

describe('POST /api/tasks', () => {
  it.each(['member', 'associate', 'analyst', 'vp'])('a %s can create a task for themselves', async (role) => {
    const res = await request(await app(role)).post('/api/tasks').send({ title: 'Call the broker', assignedTo: ME });
    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
  });

  it('a member can create an unassigned task', async () => {
    const res = await request(await app('member')).post('/api/tasks').send({ title: 'Read the CIM' });
    expect(res.status).toBe(201);
  });

  it('a member cannot assign a task to someone else', async () => {
    const res = await request(await app('member')).post('/api/tasks')
      .send({ title: 'Do my work', assignedTo: '22222222-2222-2222-2222-222222222222' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TASK_ASSIGN_FORBIDDEN');
    expect(inserted).toHaveLength(0);
  });

  it('a partner can assign a task to someone else', async () => {
    const res = await request(await app('partner')).post('/api/tasks')
      .send({ title: 'Model the deal', assignedTo: '22222222-2222-2222-2222-222222222222' });
    expect(res.status).toBe(201);
  });

  it('a viewer cannot create tasks', async () => {
    const res = await request(await app('viewer')).post('/api/tasks').send({ title: 'x' });
    expect(res.status).toBe(403);
  });
});

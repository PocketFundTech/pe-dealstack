import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// resolveUserId lives in routes/notifications.js (reused, not duplicated —
// see routes/tasks.ts for the same import pattern). Mock it directly so
// these tests don't need to also stand up the User-table lookup query.
const resolveUserIdMock = vi.fn();
vi.mock('../src/routes/notifications.js', () => ({ resolveUserId: resolveUserIdMock }));

const buildApp = async (authId: string | null = 'auth-1') => {
  const { default: router } = await import('../src/routes/snoozes.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = authId ? { id: authId } : undefined;
    next();
  });
  app.use('/api', router);
  return app;
};

describe('snoozes routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
    resolveUserIdMock.mockReset();
    resolveUserIdMock.mockResolvedValue('user-internal-1');
  });

  describe('GET /api/snoozes', () => {
    it('returns only this user\'s still-active snoozes, filtered server-side (until > now)', async () => {
      let eqCol: string | null = null;
      let eqVal: string | null = null;
      let gtCol: string | null = null;

      mockSupabase.from.mockImplementation((table: string) => {
        expect(table).toBe('DashboardSnooze');
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              eqCol = col;
              eqVal = val;
              return {
                gt: (col2: string, _val2: string) => {
                  gtCol = col2;
                  return Promise.resolve({
                    data: [{ itemKey: 'task:t1', until: '2026-10-05T00:00:00Z' }],
                    error: null,
                  });
                },
              };
            },
          }),
        };
      });

      const app = await buildApp();
      const res = await request(app).get('/api/snoozes');

      expect(res.status).toBe(200);
      expect(eqCol).toBe('userId');
      expect(eqVal).toBe('user-internal-1');
      expect(gtCol).toBe('until');
      expect(res.body).toEqual({ snoozes: { 'task:t1': '2026-10-05T00:00:00Z' } });
    });

    it('401s when there is no authenticated user', async () => {
      const app = await buildApp(null);
      const res = await request(app).get('/api/snoozes');
      expect(res.status).toBe(401);
    });

    it('403s when the auth id has no matching internal user', async () => {
      resolveUserIdMock.mockResolvedValue(null);
      const app = await buildApp();
      const res = await request(app).get('/api/snoozes');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/snoozes', () => {
    it('upserts on (userId, itemKey) so re-snoozing moves the expiry out', async () => {
      let upserted: any = null;
      let onConflict: string | undefined;

      mockSupabase.from.mockImplementation((table: string) => {
        expect(table).toBe('DashboardSnooze');
        return {
          upsert: (row: any, opts: { onConflict: string }) => {
            upserted = row;
            onConflict = opts.onConflict;
            return Promise.resolve({ error: null });
          },
        };
      });

      const app = await buildApp();
      const res = await request(app)
        .post('/api/snoozes')
        .send({ itemKey: 'task:t1', until: '2026-10-05T00:00:00.000Z' });

      expect(res.status).toBe(200);
      expect(upserted).toEqual({ userId: 'user-internal-1', itemKey: 'task:t1', until: '2026-10-05T00:00:00.000Z' });
      expect(onConflict).toBe('userId,itemKey');
    });

    it('rejects a non-ISO until value with 400 before touching the database', async () => {
      const app = await buildApp();
      const res = await request(app).post('/api/snoozes').send({ itemKey: 'task:t1', until: 'not-a-date' });
      expect(res.status).toBe(400);
      expect(mockSupabase.from).not.toHaveBeenCalled();
    });

    it('rejects a missing itemKey with 400', async () => {
      const app = await buildApp();
      const res = await request(app).post('/api/snoozes').send({ until: '2026-10-05T00:00:00.000Z' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/snoozes/:itemKey', () => {
    it('deletes scoped to userId + itemKey, both from this user only', async () => {
      let eqCalls: Array<[string, string]> = [];
      mockSupabase.from.mockImplementation((table: string) => {
        expect(table).toBe('DashboardSnooze');
        const builder: any = {
          delete: () => builder,
          eq: (col: string, val: string) => {
            eqCalls.push([col, val]);
            return eqCalls.length < 2 ? builder : Promise.resolve({ error: null });
          },
        };
        return builder;
      });

      const app = await buildApp();
      // Item keys contain a colon + UUID — the frontend encodeURIComponent()s
      // them; Express decodes route params automatically.
      const res = await request(app).delete('/api/snoozes/' + encodeURIComponent('unowned:3eda9d69-2f2c-4e4e-ab4e-29509119dab2'));

      expect(res.status).toBe(200);
      expect(eqCalls).toEqual([
        ['userId', 'user-internal-1'],
        ['itemKey', 'unowned:3eda9d69-2f2c-4e4e-ab4e-29509119dab2'],
      ]);
    });
  });
});

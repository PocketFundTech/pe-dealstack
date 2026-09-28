import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { requireInternalAdmin } from '../middleware/internalAdmin.js';

const router = Router();
router.use(requireInternalAdmin);

// GET /api/internal/usage/events?org=&user=&operation=&from=&to=&errorsOnly=&limit=200
router.get('/usage/events', async (req: Request, res: Response) => {
  const { org, user, operation, from, to, errorsOnly, limit } = req.query;
  let q = supabase
    .from('UsageEvent')
    .select('*, User:userId (email), Organization:organizationId (name)')
    .order('createdAt', { ascending: false })
    .limit(Math.min(Number(limit ?? 200), 1000));
  if (org) q = q.eq('organizationId', String(org));
  if (user) q = q.eq('userId', String(user));
  if (operation) q = q.eq('operation', String(operation));
  if (from) q = q.gte('createdAt', String(from));
  if (to) q = q.lte('createdAt', String(to));
  if (errorsOnly === 'true') q = q.neq('status', 'success');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data ?? [] });
});

// GET /api/internal/usage/leaderboard?window=24h|7d|30d
router.get('/usage/leaderboard', async (req: Request, res: Response) => {
  const window = String(req.query.window ?? '30d');
  const since = new Date();
  if (window === '24h') since.setHours(since.getHours() - 24);
  else if (window === '7d') since.setDate(since.getDate() - 7);
  else since.setDate(since.getDate() - 30);

  const { data, error } = await supabase
    .from('UsageEvent')
    .select('userId, organizationId, operation, totalTokens, costUsd, credits')
    .gte('createdAt', since.toISOString());
  if (error) return res.status(500).json({ error: error.message });

  type Row = {
    userId: string;
    organizationId: string;
    calls: number;
    tokens: number;
    costUsd: number;
    credits: number;
    topOperation: string;
    ops: Map<string, number>;
  };
  const byUser = new Map<string, Row>();
  for (const e of (data ?? []) as Array<{
    userId: string;
    organizationId: string;
    operation: string;
    totalTokens: number | null;
    costUsd: number | null;
    credits: number | null;
  }>) {
    let row = byUser.get(e.userId);
    if (!row) {
      row = {
        userId: e.userId,
        organizationId: e.organizationId,
        calls: 0,
        tokens: 0,
        costUsd: 0,
        credits: 0,
        topOperation: '',
        ops: new Map(),
      };
      byUser.set(e.userId, row);
    }
    row.calls += 1;
    row.tokens += Number(e.totalTokens ?? 0);
    row.costUsd += Number(e.costUsd ?? 0);
    row.credits += Number(e.credits ?? 0);
    row.ops.set(e.operation, (row.ops.get(e.operation) ?? 0) + 1);
  }
  const rows = [...byUser.values()].map((r) => {
    const topOperation =
      [...r.ops.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    return {
      userId: r.userId,
      organizationId: r.organizationId,
      calls: r.calls,
      tokens: r.tokens,
      costUsd: r.costUsd,
      credits: r.credits,
      topOperation,
    };
  });

  // Hydrate user emails + org names + role + flags
  const userIds = rows.map((r) => r.userId);
  const orgIds = [...new Set(rows.map((r) => r.organizationId))];
  const [userRes, orgRes] = await Promise.all([
    userIds.length
      ? supabase
          .from('User')
          .select('id, email, role, isInternal, isThrottled, isBlocked, organizationId')
          .in('id', userIds)
      : Promise.resolve({ data: [] as any[] }),
    orgIds.length
      ? supabase.from('Organization').select('id, name').in('id', orgIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);
  const userMap = new Map((userRes.data ?? []).map((u: any) => [u.id, u]));
  const orgMap = new Map((orgRes.data ?? []).map((o: any) => [o.id, o.name]));

  const hydrated = rows
    .map((r) => ({
      ...r,
      email: userMap.get(r.userId)?.email,
      role: userMap.get(r.userId)?.role,
      isThrottled: userMap.get(r.userId)?.isThrottled,
      isBlocked: userMap.get(r.userId)?.isBlocked,
      orgName: orgMap.get(r.organizationId),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  res.json({ rows: hydrated, window });
});

// GET /api/internal/usage/cost-breakdown?days=30
router.get('/usage/cost-breakdown', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days ?? 30), 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from('UsageEvent')
    .select('createdAt, operation, costUsd, credits')
    .gte('createdAt', since.toISOString());
  if (error) return res.status(500).json({ error: error.message });

  const byDay = new Map<string, Map<string, number>>();
  const opTotals = new Map<string, { costUsd: number; credits: number }>();
  for (const e of (data ?? []) as Array<{
    createdAt: string;
    operation: string;
    costUsd: number | null;
    credits: number | null;
  }>) {
    const day = String(e.createdAt).slice(0, 10);
    let m = byDay.get(day);
    if (!m) {
      m = new Map();
      byDay.set(day, m);
    }
    m.set(e.operation, (m.get(e.operation) ?? 0) + Number(e.costUsd ?? 0));
    const cur = opTotals.get(e.operation) ?? { costUsd: 0, credits: 0 };
    cur.costUsd += Number(e.costUsd ?? 0);
    cur.credits += Number(e.credits ?? 0);
    opTotals.set(e.operation, cur);
  }
  const series = [...byDay.entries()]
    .sort()
    .map(([day, m]) => ({ day, byOperation: Object.fromEntries(m) }));
  const reconciliation = [...opTotals.entries()]
    .map(([operation, totals]) => ({ operation, ...totals }))
    .sort((a, b) => b.costUsd - a.costUsd);
  res.json({ series, reconciliation });
});

// GET /api/internal/usage/reconciliation?days=30
// Reads the daily Anthropic ledger-vs-billing drift rows written by the
// usage-reconciliation cron (src/routes/cron-usage-reconciliation.ts). The
// table (UsageReconciliation) is created by usage-cost-accuracy-migration.sql,
// which is run by hand — degrade to an empty list rather than 500 if it's
// not there yet.
router.get('/usage/reconciliation', async (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days ?? 30), 365);
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data, error } = await supabase
    .from('UsageReconciliation')
    .select('*')
    .gte('day', since.toISOString().slice(0, 10))
    .order('day', { ascending: false });

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return res.json({ rows: [] });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json({ rows: data ?? [] });
});

// POST /api/internal/users/:userId/throttle  body: { value: boolean }
router.post('/users/:userId/throttle', async (req: Request, res: Response) => {
  const { value } = req.body;
  const { error } = await supabase
    .from('User')
    .update({ isThrottled: !!value })
    .eq('id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/internal/users/:userId/block  body: { value: boolean }
router.post('/users/:userId/block', async (req: Request, res: Response) => {
  const { value } = req.body;
  const { error } = await supabase
    .from('User')
    .update({ isBlocked: !!value })
    .eq('id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;

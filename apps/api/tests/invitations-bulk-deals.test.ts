/**
 * QA #4: bulk invite rows carry a deal. POST /invitations/bulk accepts
 * `invites: [{ email, dealId }]`; the invitee joins the deal's team on
 * accept, existing members join immediately; works before the migration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
let invitationHasDealColumn = true;

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let insertRow: Row | null = null;
  const run = () => {
    if (insertRow) {
      if (table === 'Invitation' && !invitationHasDealColumn && 'dealId' in insertRow) {
        return { data: null, error: { code: 'PGRST204', message: "Could not find the 'dealId' column" } };
      }
      const row = { id: `${table}-${(db[table] ??= []).length + 1}`, ...insertRow };
      db[table].push(row);
      return { data: row, error: null };
    }
    const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    return { data: rows, error: null };
  };
  const b: any = {
    select: () => b,
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
    insert: (row: Row) => { insertRow = row; return b; },
    update: () => b,
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { log: async () => {} } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));
const sent: string[] = [];
vi.mock('../src/services/invitationEmail.js', () => ({
  sendInvitationEmail: async (email: string) => { sent.push(email); },
  getExpirationDate: () => new Date(Date.now() + 86_400_000),
  resolveBaseUrl: () => 'http://x',
}));

const { default: router } = await import('../src/routes/invitations.js');
const { applyInvitationDeal } = await import('../src/services/invitationAccept.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _r, next) => { req.user = { id: 'auth-admin' }; next(); });
  a.use('/api/invitations', router);
  return a;
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.User = [
    { id: 'admin', authId: 'auth-admin', name: 'Admin', organizationId: 'org-A', role: 'ADMIN' },
    { id: 'u-existing', email: 'old@firm.com', organizationId: 'org-A' },
  ];
  db.Organization = [{ id: 'org-A', name: 'Acme' }];
  db.Deal = [{ id: '11111111-1111-1111-1111-111111111111', organizationId: 'org-A' }, { id: '22222222-2222-2222-2222-222222222222', organizationId: 'org-B' }];
  db.Invitation = [];
  db.DealTeamMember = [];
  invitationHasDealColumn = true;
  sent.length = 0;
});

const DEAL = '11111111-1111-1111-1111-111111111111';

describe('POST /api/invitations/bulk with deals', () => {
  it('stores the deal on a new invitation', async () => {
    const res = await request(app()).post('/api/invitations/bulk')
      .send({ role: 'MEMBER', invites: [{ email: 'new@firm.com', dealId: DEAL }, { email: 'plain@firm.com' }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { email: 'new@firm.com', status: 'sent', deal: 'on_accept' },
      { email: 'plain@firm.com', status: 'sent' },
    ]);
    expect(db.Invitation.find((i) => i.email === 'new@firm.com')?.dealId).toBe(DEAL);
  });

  it('adds an existing member to the deal straight away', async () => {
    const res = await request(app()).post('/api/invitations/bulk').send({ invites: [{ email: 'old@firm.com', dealId: DEAL }] });
    expect(res.body.results[0]).toEqual({ email: 'old@firm.com', status: 'exists', deal: 'added' });
    expect(db.DealTeamMember).toEqual([expect.objectContaining({ dealId: DEAL, userId: 'u-existing' })]);
  });

  it('rejects a deal from another org', async () => {
    const res = await request(app()).post('/api/invitations/bulk')
      .send({ invites: [{ email: 'x@firm.com', dealId: '22222222-2222-2222-2222-222222222222' }] });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('still sends (without the deal) before the migration runs', async () => {
    invitationHasDealColumn = false;
    const res = await request(app()).post('/api/invitations/bulk').send({ invites: [{ email: 'new@firm.com', dealId: DEAL }] });
    expect(res.body.results[0]).toEqual({ email: 'new@firm.com', status: 'sent', deal: 'not_saved' });
    expect(sent).toEqual(['new@firm.com']);
  });

  it('keeps accepting the old { emails } shape', async () => {
    const res = await request(app()).post('/api/invitations/bulk').send({ emails: ['a@firm.com'], role: 'VIEWER' });
    expect(res.body.results).toEqual([{ email: 'a@firm.com', status: 'sent' }]);
  });
});

describe('applyInvitationDeal (on accept)', () => {
  it('adds the new member to the invited deal once', async () => {
    const inv = { id: 'i1', email: 'n@f.com', firmName: 'Acme', organizationId: 'org-A', role: 'MEMBER', status: 'PENDING', expiresAt: '', dealId: DEAL };
    await applyInvitationDeal(inv, 'u-new');
    await applyInvitationDeal(inv, 'u-new');
    expect(db.DealTeamMember).toEqual([expect.objectContaining({ dealId: DEAL, userId: 'u-new', role: 'MEMBER' })]);
  });

  it('ignores a deal outside the invitation\'s org', async () => {
    await applyInvitationDeal({ id: 'i2', email: 'n@f.com', firmName: 'Acme', organizationId: 'org-A', role: 'MEMBER', status: 'PENDING', expiresAt: '', dealId: '22222222-2222-2222-2222-222222222222' }, 'u-new');
    expect(db.DealTeamMember).toHaveLength(0);
  });
});

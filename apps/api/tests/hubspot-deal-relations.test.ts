import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));

import { linkDealContacts, loadOrgUsersByEmail, applyDealOwner, ownerLabel } from '../src/services/hubspot/dealRelations.js';

beforeEach(() => { chain.calls.length = 0; resolver = () => undefined; });

describe('linkDealContacts', () => {
  it('upserts with ignoreDuplicates and returns how many were new', async () => {
    resolver = (op) => (op.table === 'ContactDeal' ? { data: [{ id: 'l1' }] } : undefined);
    const n = await linkDealContacts('deal-1', ['c1', 'c2']);
    expect(n).toBe(1);
    const op = chain.calls.find((c) => c.table === 'ContactDeal')!;
    expect(op.action).toBe('upsert');
    expect(op.payload).toEqual([
      { contactId: 'c1', dealId: 'deal-1', role: 'OTHER' },
      { contactId: 'c2', dealId: 'deal-1', role: 'OTHER' },
    ]);
  });

  it('does nothing for an empty list', async () => {
    expect(await linkDealContacts('deal-1', [])).toBe(0);
    expect(chain.calls).toHaveLength(0);
  });

  it('throws on a database error', async () => {
    resolver = () => ({ error: { message: 'boom' } });
    await expect(linkDealContacts('deal-1', ['c1'])).rejects.toThrow(/boom/);
  });
});

describe('loadOrgUsersByEmail', () => {
  it('maps lower-cased email → User.id for the org', async () => {
    resolver = (op) => (op.table === 'User' ? { data: [{ id: 'u1', email: 'Ann@X.com' }, { id: 'u2', email: null }] } : undefined);
    const map = await loadOrgUsersByEmail('org-1');
    expect([...map]).toEqual([['ann@x.com', 'u1']]);
    expect(filterValue(chain.calls[0], 'organizationId')).toBe('org-1');
  });
});

describe('applyDealOwner', () => {
  it('no matching user → no_match, no writes', async () => {
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: null, mode: 'fill' })).toBe('no_match');
    expect(chain.calls).toHaveLength(0);
  });

  it('fill mode keeps an existing Lead Partner', async () => {
    resolver = (op) => (op.table === 'Deal' && op.action === 'select' ? { data: { assignedTo: 'someone-else' } } : undefined);
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: 'u1', mode: 'fill' })).toBe('kept_existing');
    expect(chain.calls.some((c) => c.action === 'update' || c.action === 'insert')).toBe(false);
  });

  it('already the Lead Partner → already, no writes', async () => {
    resolver = (op) => (op.table === 'Deal' && op.action === 'select' ? { data: { assignedTo: 'u1' } } : undefined);
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: 'u1', mode: 'fill' })).toBe('already');
    expect(chain.calls.some((c) => c.action === 'update')).toBe(false);
  });

  it('sets assignedTo and adds a LEAD team member when absent', async () => {
    resolver = (op) => {
      if (op.table === 'Deal' && op.action === 'select') return { data: { assignedTo: null } };
      if (op.table === 'DealTeamMember' && op.action === 'select') return { data: null };
      return undefined;
    };
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: 'u1', mode: 'fill' })).toBe('set');
    expect(chain.calls.find((c) => c.table === 'Deal' && c.action === 'update')?.payload).toMatchObject({ assignedTo: 'u1' });
    expect(chain.calls.find((c) => c.table === 'DealTeamMember' && c.action === 'insert')?.payload)
      .toEqual({ dealId: 'd1', userId: 'u1', role: 'LEAD' });
  });

  it('refresh mode replaces a different Lead Partner; existing team row is left alone', async () => {
    resolver = (op) => {
      if (op.table === 'Deal' && op.action === 'select') return { data: { assignedTo: 'old' } };
      if (op.table === 'DealTeamMember' && op.action === 'select') return { data: { id: 'tm1' } };
      return undefined;
    };
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: 'u1', mode: 'refresh' })).toBe('set');
    expect(chain.calls.some((c) => c.table === 'DealTeamMember' && c.action === 'insert')).toBe(false);
  });
});

describe('applyDealOwner team role', () => {
  it('promotes an existing MEMBER row to LEAD', async () => {
    resolver = (op) => {
      if (op.table === 'Deal' && op.action === 'select') return { data: { assignedTo: null } };
      if (op.table === 'DealTeamMember' && op.action === 'select') return { data: { id: 'tm1', role: 'MEMBER' } };
      return undefined;
    };
    expect(await applyDealOwner({ dealId: 'd1', orgId: 'org-1', ownerUserId: 'u1', mode: 'fill' })).toBe('set');
    expect(chain.calls.find((c) => c.table === 'DealTeamMember' && c.action === 'update')?.payload).toEqual({ role: 'LEAD' });
    expect(chain.calls.some((c) => c.table === 'DealTeamMember' && c.action === 'insert')).toBe(false);
    for (const c of chain.calls.filter((x) => x.table === 'Deal')) {
      expect(c.filters).toEqual(expect.arrayContaining([{ method: 'eq', args: ['organizationId', 'org-1'] }]));
    }
  });
});

describe('ownerLabel', () => {
  it.each([
    [{ id: '1', name: 'Ann Lee', email: 'a@x.com' }, 'Ann Lee <a@x.com>'],
    [{ id: '1', name: null, email: 'a@x.com' }, 'a@x.com'],
    [{ id: '1', name: 'Ann Lee', email: null }, 'Ann Lee'],
    [{ id: '9', name: null, email: null }, 'HubSpot owner 9'],
  ])('%o → %s', (o, expected) => { expect(ownerLabel(o)).toBe(expected); });
});

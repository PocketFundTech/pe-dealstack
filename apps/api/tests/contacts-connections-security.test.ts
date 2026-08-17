import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mocks BEFORE importing the router
const mockSupabase = {
  from: vi.fn(),
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const verifyContactAccess = vi.fn();
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user?.organizationId || 'org-A',
  verifyContactAccess,
  verifyDealAccess,
}));

const buildApp = async (orgId = 'org-A') => {
  const { default: router } = await import('../src/routes/contacts-connections.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: orgId };
    next();
  });
  app.use('/api/contacts', router);
  return app;
};

describe('POST /api/contacts/:id/connections — cross-tenant protection (F-15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('returns 404 when relatedContactId is from another org', async () => {
    // Source contact is in org-A (passes), related is in org-B (fails)
    verifyContactAccess.mockImplementation(async (cid: string, oid: string) => {
      if (cid === 'contact-A1' && oid === 'org-A') return { id: 'contact-A1', organizationId: 'org-A' };
      return null; // cross-org or not found
    });

    let insertInvoked = false;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'ContactRelationship') {
        return {
          insert: () => {
            insertInvoked = true;
            return {
              select: () => ({ single: async () => ({ data: { id: 'rel-1' }, error: null }) }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/contacts/contact-A1/connections')
      .send({
        relatedContactId: '00000000-0000-0000-0000-000000000099',
        type: 'KNOWS',
      });

    expect(res.status).toBe(404);
    expect(insertInvoked).toBe(false);
    expect(verifyContactAccess).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000099', 'org-A');
  });

  it('creates the connection when both contacts are in caller org', async () => {
    verifyContactAccess.mockResolvedValue({ id: 'contact-A1', organizationId: 'org-A' });

    let insertedRow: any = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'ContactRelationship') {
        return {
          insert: (row: any) => {
            insertedRow = row;
            return {
              select: () => ({
                single: async () => ({ data: { id: 'rel-1', ...row }, error: null }),
              }),
            };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app)
      .post('/api/contacts/contact-A1/connections')
      .send({
        relatedContactId: '00000000-0000-0000-0000-000000000002',
        type: 'KNOWS',
      });

    expect(res.status).toBe(201);
    expect(insertedRow.contactId).toBe('contact-A1');
    expect(insertedRow.relatedContactId).toBe('00000000-0000-0000-0000-000000000002');
  });
});

describe('DELETE /api/contacts/:id/connections/:connectionId — cross-tenant protection (F-16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.from.mockReset();
  });

  it('constrains delete by contactId so foreign relationships cannot be deleted by id alone', async () => {
    verifyContactAccess.mockResolvedValue({ id: 'contact-A1', organizationId: 'org-A' });

    let deleteFilters: { col: string; val: any }[] = [];
    let orFilter: string | null = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'ContactRelationship') {
        const chain: any = {
          eq: (col: string, val: any) => {
            deleteFilters.push({ col, val });
            return chain;
          },
          or: (clause: string) => {
            orFilter = clause;
            return chain;
          },
          then: (onResolve: any) => Promise.resolve({ error: null }).then(onResolve),
        };
        return {
          delete: () => chain,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/contacts/contact-A1/connections/rel-1');

    expect(res.status).toBe(200);
    // delete must filter by id AND by contactId-membership (or both sides)
    const ids = deleteFilters.filter((f) => f.col === 'id').map((f) => f.val);
    expect(ids).toContain('rel-1');
    // either an .or() with both sides or an explicit equality on contactId
    const constrainedByContact =
      (orFilter && orFilter.includes('contactId') && orFilter.includes('contact-A1')) ||
      deleteFilters.some((f) => f.col === 'contactId' && f.val === 'contact-A1') ||
      deleteFilters.some((f) => f.col === 'relatedContactId' && f.val === 'contact-A1');
    expect(constrainedByContact).toBe(true);
  });

  it('returns 404 when contact is in another org', async () => {
    verifyContactAccess.mockResolvedValue(null);

    let deleteInvoked = false;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'ContactRelationship') {
        return {
          delete: () => {
            deleteInvoked = true;
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const app = await buildApp('org-A');
    const res = await request(app).delete('/api/contacts/contact-B1/connections/rel-1');

    expect(res.status).toBe(404);
    expect(deleteInvoked).toBe(false);
  });
});

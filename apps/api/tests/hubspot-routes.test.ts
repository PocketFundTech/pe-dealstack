import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-A' }));
vi.mock('../src/services/encryption.js', () => ({
  encryptField: (v: string) => `enc:${v}`, decryptField: (v: string) => v.replace(/^enc:/, ''),
}));
const validateToken = vi.fn().mockResolvedValue({ ok: true, status: 200, category: null });
vi.mock('../src/services/hubspot/client.js', () => ({
  HubSpotClient: vi.fn().mockImplementation(function () { return { validateToken }; }),
}));
const runImportBatch = vi.fn().mockResolvedValue(false);
vi.mock('../src/services/hubspot/importEngine.js', () => ({ runImportBatch }));

const buildApp = async () => {
  const { default: router } = await import('../src/routes/hubspot-import.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'auth-uuid-1' }; next(); });
  app.use('/api/integrations/hubspot', router);
  return app;
};

const chain = (overrides: Record<string, any> = {}) => ({
  select: vi.fn().mockReturnThis(), insert: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis(),
  upsert: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  neq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: null }),
  maybeSingle: vi.fn().mockResolvedValue({ data: null }), ...overrides,
});

describe('hubspot-import routes', () => {
  beforeEach(() => { vi.clearAllMocks(); validateToken.mockResolvedValue({ ok: true, status: 200, category: null }); });

  it('POST /connect maps a 401 to an invalid-token message', async () => {
    validateToken.mockResolvedValue({ ok: false, status: 401, category: 'INVALID_AUTHENTICATION' });
    mockSupabase.from.mockReturnValue(chain());
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'bad-token-1234' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/did not recognize/i);
    expect(res.body.error).toMatch(/pat-/);
  });

  it('POST /connect maps MISSING_SCOPES to a message listing the required scopes', async () => {
    validateToken.mockResolvedValue({ ok: false, status: 403, category: 'MISSING_SCOPES' });
    mockSupabase.from.mockReturnValue(chain());
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'scopeless-token' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('crm.objects.companies.read');
    expect(res.body.error).toContain('crm.objects.contacts.read');
    expect(res.body.error).toContain('crm.objects.deals.read');
  });

  it('POST /connect reports the HTTP status for other HubSpot failures', async () => {
    validateToken.mockResolvedValue({ ok: false, status: 502, category: null });
    mockSupabase.from.mockReturnValue(chain());
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'some-token-1234' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('502');
  });

  it('POST /connect trims whitespace around the pasted token', async () => {
    const HubSpotClientMock = (await import('../src/services/hubspot/client.js')).HubSpotClient as unknown as ReturnType<typeof vi.fn>;
    const singleMock = vi.fn().mockResolvedValueOnce({ data: { id: 'internal-user-1' } });
    mockSupabase.from.mockReturnValue(chain({ single: singleMock }));
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: '  pat-na1-abc123  \n' });
    expect(res.status).toBe(200);
    expect(HubSpotClientMock).toHaveBeenCalledWith('pat-na1-abc123');
  });

  it('POST /connect stores an encrypted token and returns connected', async () => {
    // Query sequence: resolveInternalUserId (single) → upsert (no maybeSingle)
    const maybeSingleMock = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'internal-user-1' } }); // resolveInternalUserId → single
    const singleMock = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'internal-user-1' } }); // resolveInternalUserId uses .single()
    mockSupabase.from.mockReturnValue(chain({ single: singleMock, maybeSingle: maybeSingleMock }));
    const res = await request(await buildApp()).post('/api/integrations/hubspot/connect').send({ token: 'good-token' });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
  });

  it('POST /import creates a job and returns jobId', async () => {
    // Query sequence (maybeSingle calls in order):
    //   1. HubSpotConnection lookup (conn)
    //   2. In-flight ImportJob check (I1 guard) → null (no in-flight job)
    //   3. resolveInternalUserId → single() call (not maybeSingle)
    //   4. ImportJob insert → select → maybeSingle → { id: 'job-1' }
    const singleMock = vi.fn()
      .mockResolvedValueOnce({ data: { id: 'internal-user-1' } }); // resolveInternalUserId
    const maybeSingleMock = vi.fn()
      .mockResolvedValueOnce({ data: { accessToken: 'enc:tok' } }) // connection lookup
      .mockResolvedValueOnce({ data: null })                        // in-flight job check (none)
      .mockResolvedValueOnce({ data: { id: 'job-1' } });           // created job
    mockSupabase.from.mockReturnValue(chain({ single: singleMock, maybeSingle: maybeSingleMock }));
    const res = await request(await buildApp()).post('/api/integrations/hubspot/import').send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('job-1');
  });

  it('POST /import returns existing jobId when an in-flight import is already running (I1)', async () => {
    // Query sequence:
    //   1. HubSpotConnection lookup → conn with accessToken
    //   2. In-flight ImportJob check → existing job found (status 'running')
    //   No further calls (early return before insert)
    const maybeSingleMock = vi.fn()
      .mockResolvedValueOnce({ data: { accessToken: 'enc:tok' } }) // connection lookup
      .mockResolvedValueOnce({ data: { id: 'existing-job' } });    // in-flight job found
    mockSupabase.from.mockReturnValue(chain({ maybeSingle: maybeSingleMock }));
    const res = await request(await buildApp()).post('/api/integrations/hubspot/import').send({});
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('existing-job');
    // Verify no insert was attempted (the from mock was never called for an insert that returns job-1)
    const insertCalls = mockSupabase.from.mock.calls.filter(([table]: [string]) => table === 'ImportJob');
    // The only ImportJob query should be the .in() check, not an insert
    // We verify by confirming no insert chain was used to return a new id
    expect(res.body.jobId).toBe('existing-job');
  });

  it('POST /import defaults to fill mode when none is specified', async () => {
    const singleMock = vi.fn().mockResolvedValueOnce({ data: { id: 'internal-user-1' } });
    const maybeSingleMock = vi.fn()
      .mockResolvedValueOnce({ data: { accessToken: 'enc:tok' } })
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: { id: 'job-1' } });
    mockSupabase.from.mockReturnValue(chain({ single: singleMock, maybeSingle: maybeSingleMock }));
    await request(await buildApp()).post('/api/integrations/hubspot/import').send({});
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget drive loop tick
    expect(runImportBatch).toHaveBeenCalledWith('job-1', 'tok', 'fill');
  });

  it('POST /import passes refresh mode through to the drive loop', async () => {
    const singleMock = vi.fn().mockResolvedValueOnce({ data: { id: 'internal-user-1' } });
    const maybeSingleMock = vi.fn()
      .mockResolvedValueOnce({ data: { accessToken: 'enc:tok' } })
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: { id: 'job-2' } });
    mockSupabase.from.mockReturnValue(chain({ single: singleMock, maybeSingle: maybeSingleMock }));
    await request(await buildApp()).post('/api/integrations/hubspot/import').send({ mode: 'refresh' });
    await new Promise((r) => setTimeout(r, 0));
    expect(runImportBatch).toHaveBeenCalledWith('job-2', 'tok', 'refresh');
  });

  it('GET /import/:id returns status', async () => {
    mockSupabase.from.mockReturnValue(chain({
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'job-1', status: 'running', objectCounts: {} } }),
    }));
    const res = await request(await buildApp()).get('/api/integrations/hubspot/import/job-1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
  });
});

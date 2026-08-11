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
vi.mock('resend', () => ({ Resend: vi.fn(() => ({ emails: { send: vi.fn() } })) }));

// Re-mock orgScope to spy on verifyDocumentAccess / verifyDealAccess
const verifyDocumentAccess = vi.fn();
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-A',
  verifyDocumentAccess,
  verifyDealAccess,
}));

const buildApp = async () => {
  const { default: router } = await import('../src/routes/documents-sharing.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-user-1', organizationId: 'org-A' };
    next();
  });
  app.use('/api', router);
  return app;
};

describe('POST /api/documents/:id/link — cross-tenant protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when source document does not belong to caller org', async () => {
    verifyDocumentAccess.mockResolvedValue(null); // cross-org doc
    const app = await buildApp();
    const res = await request(app)
      .post('/api/documents/doc-from-org-B/link')
      .send({ targetDealId: '00000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(404);
    expect(verifyDocumentAccess).toHaveBeenCalledWith('doc-from-org-B', 'org-A');
  });

  it('returns 404 when target deal does not belong to caller org', async () => {
    verifyDocumentAccess.mockResolvedValue({ id: 'doc-from-org-A', dealId: 'deal-A' });
    verifyDealAccess.mockResolvedValue(null); // cross-org target
    const app = await buildApp();
    const res = await request(app)
      .post('/api/documents/doc-from-org-A/link')
      .send({ targetDealId: '00000000-0000-0000-0000-000000000002' });

    expect(res.status).toBe(404);
    expect(verifyDealAccess).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000002',
      'org-A'
    );
  });
});

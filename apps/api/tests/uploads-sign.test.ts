/**
 * POST /api/uploads/sign — mints a signed Supabase Storage upload URL so
 * the browser can upload large files DIRECTLY to storage, bypassing
 * Vercel's 4.5MB serverless request-body cap (see ingest-shared.ts's
 * resolveUploadedFile for the server-side counterpart that reads the
 * staged file back out once the client's real ingest/upload call arrives).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createSignedUploadUrl = vi.fn();
vi.mock('../src/supabase.js', () => ({
  supabase: { storage: { from: () => ({ createSignedUploadUrl }) } },
}));

const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => {
    if (!req.user?.organizationId) throw new Error('Organization ID not available');
    return req.user.organizationId;
  },
  verifyDealAccess: (...args: any[]) => verifyDealAccess(...args),
}));

vi.mock('../src/services/fileValidator.js', () => ({
  sanitizeFilename: (n: string) => n.replace(/[^a-zA-Z0-9.\-_]/g, '_'),
  ALLOWED_MIME_TYPES: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-outlook',
    'message/rfc822',
    'image/jpeg',
    'image/png',
  ],
}));

async function buildApp(user: { id: string; organizationId?: string } | null = { id: 'u1', organizationId: 'org-A' }) {
  const { default: router } = await import('../src/routes/uploads-sign.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/uploads', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  createSignedUploadUrl.mockResolvedValue({
    data: { token: 'signed-token-abc', signedUrl: 'https://storage.example.com/signed/abc' },
    error: null,
  });
  verifyDealAccess.mockResolvedValue({ id: 'deal-1', organizationId: 'org-A' });
});

describe('POST /api/uploads/sign', () => {
  it('returns a storagePath scoped under the caller org, plus token + signedUrl', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'Big CIM.pdf', contentType: 'application/pdf', size: 10 * 1024 * 1024, purpose: 'ingest' });

    expect(res.status).toBe(200);
    expect(res.body.storagePath).toMatch(/^staging\/org-A\//);
    expect(res.body.storagePath).toMatch(/Big_CIM\.pdf$/);
    expect(res.body.token).toBe('signed-token-abc');
    expect(res.body.signedUrl).toBe('https://storage.example.com/signed/abc');
    expect(createSignedUploadUrl).toHaveBeenCalledWith(res.body.storagePath);
  });

  it('scopes different orgs to different storagePath prefixes', async () => {
    const appA = await buildApp({ id: 'u1', organizationId: 'org-A' });
    const resA = await request(appA)
      .post('/api/uploads/sign')
      .send({ fileName: 'f.pdf', contentType: 'application/pdf', size: 1024, purpose: 'ingest' });
    expect(resA.body.storagePath.startsWith('staging/org-A/')).toBe(true);

    const appB = await buildApp({ id: 'u2', organizationId: 'org-B' });
    const resB = await request(appB)
      .post('/api/uploads/sign')
      .send({ fileName: 'f.pdf', contentType: 'application/pdf', size: 1024, purpose: 'ingest' });
    expect(resB.body.storagePath.startsWith('staging/org-B/')).toBe(true);
  });

  it('500s when the caller has no organization (auth/org gate)', async () => {
    const app = await buildApp({ id: 'u1' }); // no organizationId
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'f.pdf', contentType: 'application/pdf', size: 1024, purpose: 'ingest' });
    expect(res.status).toBe(500);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a size over the ingest purpose limit (50MB) with 413', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'huge.pdf', contentType: 'application/pdf', size: 51 * 1024 * 1024, purpose: 'ingest' });
    expect(res.status).toBe(413);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('allows a size within the data-room purpose limit (up to 100MB) that would exceed the ingest limit', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'big.pdf', contentType: 'application/pdf', size: 80 * 1024 * 1024, purpose: 'data-room' });
    expect(res.status).toBe(200);
  });

  it('rejects a size over the data-room purpose limit (100MB) with 413', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'huge.pdf', contentType: 'application/pdf', size: 101 * 1024 * 1024, purpose: 'data-room' });
    expect(res.status).toBe(413);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed file type', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/uploads/sign')
      .send({ fileName: 'virus.exe', contentType: 'application/x-msdownload', size: 1024, purpose: 'ingest' });
    expect(res.status).toBe(400);
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('verifies deal access when dealId is provided, 403s on failure', async () => {
    verifyDealAccess.mockResolvedValueOnce(null);
    const app = await buildApp();
    const res = await request(app).post('/api/uploads/sign').send({
      fileName: 'f.pdf',
      contentType: 'application/pdf',
      size: 1024,
      purpose: 'ingest',
      dealId: '11111111-1111-1111-1111-111111111111',
    });
    expect(res.status).toBe(403);
    expect(verifyDealAccess).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'org-A');
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('succeeds when dealId access check passes', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/uploads/sign').send({
      fileName: 'f.pdf',
      contentType: 'application/pdf',
      size: 1024,
      purpose: 'ingest',
      dealId: '11111111-1111-1111-1111-111111111111',
    });
    expect(res.status).toBe(200);
    expect(verifyDealAccess).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111', 'org-A');
  });

  it('validates required fields', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/uploads/sign').send({ purpose: 'ingest' });
    expect(res.status).toBe(400);
  });
});

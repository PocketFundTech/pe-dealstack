import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock.js';

/**
 * Data-room folder references must stay inside the document's / folder's own
 * deal. PATCH /api/documents/:id accepted any folderId (planting the doc in
 * another org's VDR folder), and folder create / PATCH accepted any parentId.
 */

const DEAL_A = '33333333-3333-4333-8333-333333333333';

let resolver: (op: ChainOp) => ChainResult | undefined = () => ({});
let mock = makeSupabaseChainMock((op) => resolver(op));

vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => mock.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('../src/utils/storage.js', () => ({
  getSignedDownloadUrl: vi.fn(), extractStoragePath: vi.fn(), downloadFileBuffer: vi.fn(),
}));
vi.mock('../src/services/documentActivity.js', () => ({ recordDocumentDownload: vi.fn() }));
vi.mock('../src/routes/documents-upload.js', () => ({ default: Router() }));
vi.mock('../src/routes/documents-sharing.js', () => ({ default: Router() }));
vi.mock('../src/routes/folders-insights.js', () => ({ default: Router() }));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user.organizationId,
  verifyDealAccess: async (id: string) => (id === DEAL_A ? { id } : null),
  verifyDocumentAccess: async (id: string) => (id === 'doc-a' ? { id, dealId: DEAL_A } : null),
  verifyFolderAccess: async (id: string) => (id === 'folder-a' ? { id, dealId: DEAL_A } : null),
}));

const F_A = '11111111-1111-4111-8111-111111111111'; // folder in deal-a (org A)
const F_B = '22222222-2222-4222-8222-222222222222'; // folder in org B's deal
const folderDeal: Record<string, string> = { [F_A]: DEAL_A, [F_B]: 'deal-b' };

async function buildApp() {
  const { default: documents } = await import('../src/routes/documents.js');
  const { default: folders } = await import('../src/routes/folders.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id: 'auth-a', organizationId: 'org-A' };
    next();
  });
  app.use('/api', documents);
  app.use('/api', folders);
  return app;
}

beforeEach(() => {
  mock = makeSupabaseChainMock((op) => resolver(op));
  resolver = (op) => {
    if (op.table === 'Folder' && op.action === 'select' && filterValue(op, 'id')) {
      const id = filterValue(op, 'id') as string;
      return folderDeal[id] === filterValue(op, 'dealId') ? { data: { id } } : { data: null };
    }
    if (op.action === 'select') return { data: [] };
    return { data: { id: 'row', ...(op.payload as object) } };
  };
});

const writes = (table: string) => mock.calls.filter((c) => c.table === table && (c.action === 'update' || c.action === 'insert'));

describe('PATCH /api/documents/:id — folderId bound to the document\'s deal', () => {
  it('rejects a folder from another org\'s deal', async () => {
    const res = await request(await buildApp()).patch('/api/documents/doc-a').send({ folderId: F_B });
    expect(res.status).toBe(400);
    expect(writes('Document')).toHaveLength(0);
  });

  it('allows a folder of the same deal', async () => {
    const res = await request(await buildApp()).patch('/api/documents/doc-a').send({ folderId: F_A });
    expect(res.status).toBe(200);
    expect(writes('Document')).toHaveLength(1);
  });
});

describe('Folder parentId bound to the folder\'s deal', () => {
  it('POST /deals/:dealId/folders rejects a parent from another org\'s deal', async () => {
    const res = await request(await buildApp()).post(`/api/deals/${DEAL_A}/folders`).send({ name: 'x', parentId: F_B, sortOrder: 0 });
    expect(res.status).toBe(400);
    expect(writes('Folder')).toHaveLength(0);
  });

  it('POST /deals/:dealId/folders allows a parent in the same deal', async () => {
    const res = await request(await buildApp()).post(`/api/deals/${DEAL_A}/folders`).send({ name: 'x', parentId: F_A, sortOrder: 0 });
    expect(res.status).toBe(201);
  });

  it('PATCH /folders/:id rejects a parent from another org\'s deal', async () => {
    const res = await request(await buildApp()).patch('/api/folders/folder-a').send({ parentId: F_B });
    expect(res.status).toBe(400);
    expect(writes('Folder')).toHaveLength(0);
  });
});

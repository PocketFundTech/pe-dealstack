import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const verifyDealAccess = vi.fn();
vi.mock('../src/middleware/orgScope.js', () => ({ getOrgId: () => 'org-1', verifyDealAccess: (...a: unknown[]) => verifyDealAccess(...a) }));
const embedDocument = vi.fn();
vi.mock('../src/rag.js', () => ({ embedDocument: (...a: unknown[]) => embedDocument(...a) }));

import router from '../src/routes/deals-documents-index.js';

const app = express();
app.use(express.json());
app.use('/api/deals', router);

beforeEach(() => { chain.calls.length = 0; verifyDealAccess.mockReset().mockResolvedValue(true); embedDocument.mockReset(); });

describe('GET /api/deals/:dealId/documents/index-pending', () => {
  it('counts documents with text that are not indexed yet', async () => {
    resolver = (op) => (op.table === 'Document' ? { count: 3 } : undefined);
    const res = await request(app).get('/api/deals/d1/documents/index-pending');
    expect(res.body).toEqual({ pending: 3 });
    const op = chain.calls[0];
    expect(op.filters).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['dealId', 'd1'] },
      { method: 'or', args: ['embeddingStatus.is.null,embeddingStatus.eq.pending'] },
    ]));
  });

  it('404s outside the org', async () => {
    verifyDealAccess.mockResolvedValue(false);
    expect((await request(app).get('/api/deals/d1/documents/index-pending')).status).toBe(404);
  });
});

describe('POST /api/deals/:dealId/documents/index-pending', () => {
  it('embeds pending documents and reports what is left', async () => {
    resolver = (op) => {
      if (op.table === 'Document' && op.selectOptions?.head) return { count: 0 };
      if (op.table === 'Document') return { data: [{ id: 'doc1', extractedText: 'a' }, { id: 'doc2', extractedText: 'b' }] };
      return undefined;
    };
    embedDocument.mockResolvedValueOnce({ success: true, chunkCount: 2 }).mockResolvedValueOnce({ success: false, chunkCount: 0, error: 'no model' });
    const res = await request(app).post('/api/deals/d1/documents/index-pending').send({});
    expect(res.body).toEqual({ indexed: 1, failed: 1, remaining: 0, error: 'no model' });
    expect(embedDocument).toHaveBeenCalledWith('doc1', 'd1', 'a');
  });
});

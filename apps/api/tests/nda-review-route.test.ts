/**
 * NDA review routes (spec §4.7):
 *   POST /api/deals/:dealId/nda-reviews   — upload or pick a VDR doc
 *   GET  /api/deals/:dealId/nda-reviews   — history
 *   GET  /api/nda-reviews/:id             — one full review
 *   GET/PATCH /api/organizations/nda-playbook
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dealAccess: any = { id: 'deal-1', name: 'Project Neptune' };
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyDealAccess: vi.fn(async () => dealAccess),
}));

const reviewNda = vi.fn();
class NdaReviewError extends Error {
  code: string; status: number;
  constructor(message: string, code: string, status = 400) {
    super(message); this.name = 'NdaReviewError'; this.code = code; this.status = status;
  }
}
class AIRefusalError extends Error {
  constructor() { super('refused'); this.name = 'AIRefusalError'; }
}
vi.mock('../src/services/agents/ndaReview/index.js', () => ({
  reviewNda: (...args: any[]) => reviewNda(...args),
  NdaReviewError,
  loadPlaybook: vi.fn(async () => ({ positions: [], generalNotes: '' })),
}));
vi.mock('../src/services/ai/client.js', () => ({ AIRefusalError }));

const parseTemplateFile = vi.fn();
class LegalDocParseError extends Error {
  code = 'INVALID_FILE_FORMAT'; status = 400;
}
vi.mock('../src/services/legalDocParseService.js', () => ({
  parseTemplateFile: (...args: any[]) => parseTemplateFile(...args),
  LegalDocParseError,
}));

const downloadFileBuffer = vi.fn();
vi.mock('../src/utils/storage.js', () => ({
  downloadFileBuffer: (...args: any[]) => downloadFileBuffer(...args),
}));

let reviewRows: any[] = [];
let documentRow: any = null;

function tableMock() {
  return (table: string) => {
    if (table === 'NdaReview') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: reviewRows[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: reviewRows, error: null }),
      };
      return chain;
    }
    if (table === 'Document') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: documentRow, error: null }) }) }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/nda-review.js');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: 'user-1', organizationId: 'org-1' }; next(); });
  app.use('/api', router);
  return app;
}

const REVIEW = {
  id: 'rev-1', riskLevel: 'HIGH', summary: 'Standstill is the issue.',
  findings: [{ clauseKey: 'standstill', status: 'DEAL_BREAKER', quoteVerified: true }],
  model: 'claude-fable-5', reviewedAt: '2026-08-18T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  dealAccess = { id: 'deal-1', name: 'Project Neptune' };
  reviewRows = [{ ...REVIEW, dealId: 'deal-1', organizationId: 'org-1', sourceFileName: 'nda.pdf' }];
  documentRow = { id: '11111111-1111-4111-8111-111111111111', dealId: 'deal-1', name: 'broker-nda.pdf', fileUrl: 'deal-1/nda.pdf' };
  mockSupabase.from.mockImplementation(tableMock());
  parseTemplateFile.mockResolvedValue({ bodyHtml: '<p>five (5) years</p>' });
  downloadFileBuffer.mockResolvedValue(Buffer.from('%PDF-1.4'));
  reviewNda.mockResolvedValue(REVIEW);
});

describe('POST /api/deals/:dealId/nda-reviews', () => {
  it('reviews an uploaded NDA', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'broker-nda.pdf');

    expect(res.status).toBe(201);
    expect(res.body.riskLevel).toBe('HIGH');
    expect(parseTemplateFile).toHaveBeenCalled();
    expect(reviewNda.mock.calls[0][0]).toMatchObject({
      orgId: 'org-1', dealId: 'deal-1', sourceFileName: 'broker-nda.pdf',
    });
  });

  it('reviews a document already in the data room', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .send({ documentId: '11111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(201);
    expect(downloadFileBuffer).toHaveBeenCalledWith('deal-1/nda.pdf');
    expect(reviewNda.mock.calls[0][0].documentId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('404s a document belonging to another deal', async () => {
    documentRow = { id: '22222222-2222-4222-8222-222222222222', dealId: 'someone-else', name: 'x.pdf', fileUrl: 'x' };
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .send({ documentId: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(404);
    expect(reviewNda).not.toHaveBeenCalled();
  });

  it('404s across orgs', async () => {
    dealAccess = null;
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/other/nda-reviews')
      .attach('file', Buffer.from('x'), 'nda.pdf');

    expect(res.status).toBe(404);
    expect(reviewNda).not.toHaveBeenCalled();
  });

  it('400s when neither a file nor a documentId is given', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/deals/deal-1/nda-reviews').send({});
    expect(res.status).toBe(400);
  });

  it('400s an unparseable file with the parser’s own message', async () => {
    parseTemplateFile.mockRejectedValue(new LegalDocParseError('Empty upload'));
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('x'), 'nda.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Empty upload');
  });

  it('400s a scanned/empty NDA with an actionable message', async () => {
    reviewNda.mockRejectedValue(new NdaReviewError('That file has no readable text', 'EMPTY_DOCUMENT'));
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('x'), 'scan.pdf');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_DOCUMENT');
  });

  it('maps a model refusal to 422, not 500', async () => {
    reviewNda.mockRejectedValue(new AIRefusalError());
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('x'), 'nda.pdf');

    expect(res.status).toBe(422);
  });

  it('maps a timeout to 504', async () => {
    reviewNda.mockRejectedValue(new Error('NDA review timed out after 60000ms'));
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('x'), 'nda.pdf');

    expect(res.status).toBe(504);
  });

  it('rejects a file type the parser cannot handle', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/deals/deal-1/nda-reviews')
      .attach('file', Buffer.from('MZ'), 'payload.exe');

    expect(res.status).toBe(400);
    expect(reviewNda).not.toHaveBeenCalled();
  });
});

describe('GET /api/deals/:dealId/nda-reviews', () => {
  it('lists prior reviews without their full source text', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/deals/deal-1/nda-reviews');

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].sourceHtml).toBeUndefined();
  });
});

describe('GET /api/nda-reviews/:id', () => {
  it('returns one review in full', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/nda-reviews/rev-1');

    expect(res.status).toBe(200);
    expect(res.body.review.findings).toHaveLength(1);
  });

  it('404s a review from another org', async () => {
    reviewRows = [];
    const app = await buildApp();
    expect((await request(app).get('/api/nda-reviews/rev-x')).status).toBe(404);
  });
});

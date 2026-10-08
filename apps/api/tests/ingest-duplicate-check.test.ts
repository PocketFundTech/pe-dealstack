/**
 * Two-step duplicate check on interactive intake (upload / text / URL).
 *
 * Testers: duplicate deals still got created, and the app "doesn't flag it
 * before". With `checkDuplicates: true` and a likely existing deal, the
 * server must create / merge / store NOTHING and return the candidates plus a
 * signed extraction token. The client then resends with `dealId` (add to that
 * deal) or `forceCreate` (new deal) and the token — and the AI must not run
 * again. Callers that don't send `checkDuplicates` keep the old behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));

// ─── Recording supabase mock ─────────────────────────────────────────────
const inserts: Array<{ table: string; row: any }> = [];
const storageUploads: string[] = [];
vi.mock('../src/supabase.js', () => {
  const builder = (table: string) => {
    let inserted: any = null;
    const b: any = {
      select: () => b, eq: () => b, is: () => b, ilike: () => b, order: () => b, limit: () => b, range: () => b,
      insert: (row: any) => { inserted = row; inserts.push({ table, row }); return b; },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: inserted ? { id: `${table.toLowerCase()}-new`, ...inserted } : null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null }),
    };
    return b;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      storage: { from: () => ({ upload: async (path: string) => { storageUploads.push(path); return { data: { path }, error: null }; }, remove: async () => ({}) }) },
    },
  };
});

// ─── AI + side-effect stubs ──────────────────────────────────────────────
let aiCalls = 0;
let researchCalls = 0;
let companyName = 'CSP';
const extraction = () => ({
  companyName: { value: companyName, confidence: 90 },
  industry: { value: 'Energy', confidence: 80 },
  description: { value: 'Community solar developer', confidence: 90 },
  currency: 'USD',
  revenue: { value: 50, confidence: 90 },
  ebitda: { value: 10, confidence: 90 },
  ebitdaMargin: { value: 20, confidence: 90 },
  dealSize: { value: null, confidence: 0 },
  revenueGrowth: { value: 15, confidence: 80 },
  employees: { value: 500, confidence: 70 },
  foundedYear: { value: null, confidence: 0 },
  headquarters: { value: null, confidence: 0 },
  keyRisks: [], investmentHighlights: [], summary: 'test', overallConfidence: 85, needsReview: false, reviewReasons: [],
});
vi.mock('../src/services/aiExtractor.js', () => ({
  extractDealDataFromText: async () => { aiCalls++; return extraction(); },
}));
vi.mock('../src/services/companyResearcher.js', () => ({
  researchCompany: async () => { researchCalls++; return { companyWebsite: { scrapedPages: ['https://csp.example/'] } }; },
  buildResearchText: () => 'Community Solar Platform builds community solar farms across the US. '.repeat(5),
}));
const merged: string[] = [];
vi.mock('../src/services/dealMerger.js', () => ({
  mergeIntoExistingDeal: async (dealId: string) => { merged.push(dealId); return { deal: { id: dealId, name: 'Community Solar Platform', company: { name: 'Community Solar Platform Holdings' } } }; },
  getIconForIndustry: () => 'briefcase',
}));
const candidates = [{ id: 'deal-csp', name: 'Community Solar Platform', companyName: 'Community Solar Platform Holdings', reason: 'similar' }];
let candidateList: typeof candidates = candidates;
let liveMatch: { id: string; name: string } | null = null;
vi.mock('../src/services/dealDuplicates.js', () => ({
  findDuplicateCandidates: async () => candidateList,
  findLiveDealForCompany: async () => liveMatch,
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: (req: any) => req.user.organizationId,
  verifyDealAccess: async () => ({ id: 'deal-csp' }),
}));
vi.mock('../src/rag.js', () => ({ embedDocument: async () => ({ success: true, chunkCount: 1 }) }));
vi.mock('../src/services/auditLog.js', () => ({ AuditLog: { aiIngest: async () => {} } }));
vi.mock('../src/services/financialValidator.js', () => ({ validateFinancials: () => ({ isValid: true, warnings: [] }) }));
vi.mock('../src/routes/notifications.js', () => ({ resolveUserId: async () => null }));
vi.mock('../src/services/documentDedup.js', () => ({ findExistingDocument: async () => null, logDuplicateSkip: () => {} }));
vi.mock('../src/services/outboundWebhooks.js', () => ({ emitWebhookEvent: () => {} }));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: () => {} }));
vi.mock('../src/utils/urlHelpers.js', () => ({ isPrivateUrl: () => false }));
vi.mock('../src/services/langExtractClient.js', () => ({ deepExtract: async () => null, isDeepExtractionAvailable: () => false }));

const { default: uploadRouter } = await import('../src/routes/ingest-upload.js');
const { default: textRouter } = await import('../src/routes/ingest-text.js');
const { default: urlRouter } = await import('../src/routes/ingest-url.js');

function appFor(orgId = 'org-A') {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req: any, _res, next) => { req.user = { id: 'u1', organizationId: orgId }; next(); });
  app.use('/api/ingest', uploadRouter);
  app.use('/api/ingest', textRouter);
  app.use('/api/ingest', urlRouter);
  return app;
}

const createdDeals = () => inserts.filter((i) => i.table === 'Deal');
const createdDocs = () => inserts.filter((i) => i.table === 'Document');

beforeEach(() => {
  inserts.length = 0;
  storageUploads.length = 0;
  merged.length = 0;
  aiCalls = 0;
  researchCalls = 0;
  companyName = 'CSP';
  candidateList = candidates;
  liveMatch = null;
});

const FILE = Buffer.from('CSP teaser. Community Solar Platform Holdings develops community solar projects across the US.');
const TEXT = 'CSP (Community Solar Platform) is raising growth equity. Revenue $50M, EBITDA $10M, 500 staff.';
const URL_ = 'https://csp.example/';

type Kind = 'upload' | 'text' | 'url';
function send(kind: Kind, fields: Record<string, unknown>, opts: { file?: Buffer; text?: string; url?: string; orgId?: string } = {}) {
  const app = appFor(opts.orgId);
  if (kind === 'upload') {
    const r = request(app).post('/api/ingest').attach('file', opts.file ?? FILE, { filename: 'csp-teaser.txt', contentType: 'text/plain' });
    for (const [k, v] of Object.entries(fields)) r.field(k, String(v));
    return r;
  }
  if (kind === 'text') return request(app).post('/api/ingest/text').send({ text: opts.text ?? TEXT, ...fields });
  return request(app).post('/api/ingest/url').send({ url: opts.url ?? URL_, ...fields });
}
const extractions = () => aiCalls;

describe.each<Kind>(['upload', 'text', 'url'])('%s intake — duplicate check', (kind) => {
  it('asks first: returns candidates + token and creates, merges and stores nothing', async () => {
    const res = await send(kind, { checkDuplicates: true });
    expect(res.status).toBe(200);
    expect(res.body.duplicateCheck).toEqual({ candidates, extractedCompanyName: 'CSP' });
    expect(typeof res.body.extractionToken).toBe('string');
    expect(res.body.deal).toBeUndefined();
    expect(inserts).toEqual([]);
    expect(merged).toEqual([]);
    expect(storageUploads).toEqual([]);
    expect(extractions()).toBe(1);
  });

  it('"Add to <deal>": resend with dealId + token merges into that deal without calling the AI again', async () => {
    const first = await send(kind, { checkDuplicates: true });
    aiCalls = 0; researchCalls = 0;
    const res = await send(kind, { checkDuplicates: true, dealId: '00000000-0000-4000-8000-000000000001', extractionToken: first.body.extractionToken });
    expect(res.status).toBe(200);
    expect(res.body.isUpdate).toBe(true);
    expect(merged).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(createdDeals()).toEqual([]);
    expect(createdDocs()).toHaveLength(1);
    expect(extractions()).toBe(0);
    if (kind === 'url') expect(researchCalls).toBe(0);
  });

  it('"Create a new deal anyway": resend with forceCreate + token creates a deal without calling the AI again', async () => {
    const first = await send(kind, { checkDuplicates: true });
    aiCalls = 0; researchCalls = 0;
    const res = await send(kind, { checkDuplicates: true, forceCreate: true, extractionToken: first.body.extractionToken });
    expect(res.status).toBe(201);
    expect(res.body.duplicateCheck).toBeUndefined();
    expect(createdDeals()).toHaveLength(1);
    expect(createdDeals()[0].row.name).toBe('CSP');
    expect(merged).toEqual([]);
    expect(extractions()).toBe(0);
  });

  it('a token from another org is ignored — the AI runs again', async () => {
    const first = await send(kind, { checkDuplicates: true }, { orgId: 'org-B' });
    aiCalls = 0;
    const res = await send(kind, { forceCreate: true, extractionToken: first.body.extractionToken });
    expect(res.status).toBe(201);
    expect(extractions()).toBe(1);
  });

  it('no likely duplicate: creates the deal straight away', async () => {
    candidateList = [];
    const res = await send(kind, { checkDuplicates: true });
    expect(res.status).toBe(201);
    expect(res.body.duplicateCheck).toBeUndefined();
    expect(createdDeals()).toHaveLength(1);
  });

  it('legacy callers (no checkDuplicates) still auto-merge an exact match and say so', async () => {
    liveMatch = { id: 'deal-csp', name: 'CSP' };
    const res = await send(kind, {});
    expect(res.status).toBe(200);
    expect(res.body.duplicateCheck).toBeUndefined();
    expect(res.body.matchedExistingDeal).toEqual({ id: 'deal-csp', name: 'CSP' });
    expect(merged).toEqual(['deal-csp']);
  });
});

describe('upload token is bound to the file', () => {
  it('a token for a different file is ignored — the AI runs again', async () => {
    const first = await send('upload', { checkDuplicates: true });
    aiCalls = 0;
    const res = await send('upload', { forceCreate: true, extractionToken: first.body.extractionToken }, { file: Buffer.concat([FILE, Buffer.from(' changed')]) });
    expect(res.status).toBe(201);
    expect(extractions()).toBe(1);
  });
});

/**
 * POST /api/folders/:id/generate-insights (folders-insights.ts)
 *
 * Regression coverage for the "still requires OpenAI" production bug:
 * production has no working OpenAI key, so this route always 503'd with a
 * message telling the user to configure OPENAI_API_KEY, even though the
 * generator (folderInsightsGenerator.ts) now runs on the same
 * Anthropic-backed path as the rest of the product. Asserts the route's
 * unavailable-AI message no longer mentions OpenAI, and that a successful
 * generation still saves + returns the same FolderInsight shape the VDR UI
 * (transformInsights in web-next) expects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/middleware/orgScope.js', () => ({
  getOrgId: () => 'org-1',
  verifyFolderAccess: vi.fn(async () => ({ id: 'folder-1' })),
}));

const generateFolderInsights = vi.fn();
// Plain-function rejection: a throwing vi.fn behind the route's dynamic
// import trips a Vitest 4 quirk, so failures are injected here instead.
let insightsError: Error | null = null;
vi.mock('../src/services/folderInsightsGenerator.js', () => ({
  generateFolderInsights: (...args: any[]) => (insightsError ? Promise.reject(insightsError) : generateFolderInsights(...args)),
}));

let folderRow: any;
let dealRow: any;
let documents: any[];
let deletedFolderId: string | null;
let insertedInsight: any;

function tableMock() {
  return (table: string) => {
    if (table === 'Folder') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: folderRow, error: folderRow ? null : { message: 'not found' } }) }) }) };
    }
    if (table === 'Deal') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: dealRow, error: null }) }) }) };
    }
    if (table === 'Document') {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        order: async () => ({ data: documents, error: null }),
      };
      return chain;
    }
    if (table === 'FolderInsight') {
      return {
        delete: () => ({ eq: (_col: string, id: string) => { deletedFolderId = id; return Promise.resolve({ error: null }); } }),
        insert: (row: any) => ({
          select: () => ({
            single: async () => {
              insertedInsight = { id: 'insight-1', ...row };
              return { data: insertedInsight, error: null };
            },
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

async function buildApp() {
  const { default: router } = await import('../src/routes/folders-insights.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  deletedFolderId = null;
  insertedInsight = null;
  folderRow = { id: 'folder-1', name: 'Financials', dealId: 'deal-1', description: null };
  dealRow = { name: 'Project Neptune', industry: 'Software', stage: 'DUE_DILIGENCE', revenue: 10, ebitda: 2, company: null };
  documents = [{ id: 'doc-1', name: 'CIM.pdf', mimeType: 'application/pdf', fileSize: 12345, aiAnalysis: null, createdAt: '2026-09-01T00:00:00Z' }];
  mockSupabase.from.mockImplementation(tableMock());
  insightsError = null;
});

describe('POST /api/folders/:id/generate-insights', () => {
  it('503s with an Anthropic-specific message (never mentions OpenAI) when AI is unavailable', async () => {
    generateFolderInsights.mockResolvedValue(null);
    const app = await buildApp();

    const res = await request(app).post('/api/folders/folder-1/generate-insights').send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(res.body.error).not.toMatch(/OPENAI_API_KEY|OpenAI/i);
  });

  // Live QA 2026-10-01: production was out of Anthropic credit, but the
  // panel said "Check that ANTHROPIC_API_KEY is configured" — the route
  // reported every AI failure as a missing key.
  it('reports an out-of-credit AI provider as such, not as a missing key', async () => {
    insightsError = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
    const app = await buildApp();

    const res = await request(app).post('/api/folders/folder-1/generate-insights').send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/AI service \(Anthropic\).*credits are exhausted/i);
    expect(res.body.error).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('saves and returns the generated insights in the shape the VDR UI expects', async () => {
    generateFolderInsights.mockResolvedValue({
      summary: 'Mostly complete.',
      completionPercent: 80,
      redFlags: [{ id: 'rf1', severity: 'high', title: 'Missing audited financials', description: 'desc' }],
      missingDocuments: [{ id: 'md1', name: 'Tax Returns' }],
    });
    const app = await buildApp();

    const res = await request(app).post('/api/folders/folder-1/generate-insights').send({});

    expect(res.status).toBe(201);
    expect(deletedFolderId).toBe('folder-1');
    expect(res.body).toMatchObject({
      folderId: 'folder-1',
      summary: 'Mostly complete.',
      completionPercent: 80,
      redFlags: [{ id: 'rf1', severity: 'high', title: 'Missing audited financials', description: 'desc' }],
      missingDocuments: [{ id: 'md1', name: 'Tax Returns' }],
    });

    // Deal context (including the company join) reaches the generator.
    const [, dealContext] = generateFolderInsights.mock.calls[0];
    expect(dealContext.dealName).toBe('Project Neptune');
  });
});

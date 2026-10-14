import { describe, it, expect, vi, beforeEach } from 'vitest';

// ───── Mocks (MUST be declared before the dynamic import) ─────────

const embeddingsCtorArgs: any[] = [];
const mockEmbedDocuments = vi.fn();
const mockEmbedQuery = vi.fn();
vi.mock('@langchain/google-genai', () => ({
  GoogleGenerativeAIEmbeddings: vi.fn().mockImplementation(function (this: any, args: any) {
    embeddingsCtorArgs.push(args);
    this.embedDocuments = mockEmbedDocuments;
    this.embedQuery = mockEmbedQuery;
  }),
}));

const updates: any[] = [];
const inserts: any[] = [];
const mockRpc = vi.fn();
const mockSupabase = {
  from: vi.fn(() => ({
    update: (row: any) => { updates.push(row); return { eq: () => Promise.resolve({ error: null }) }; },
    delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    insert: (rows: any) => { inserts.push(...rows); return Promise.resolve({ error: null }); },
  })),
  rpc: mockRpc,
};
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/usage/trackedEmbeddings.js', () => ({
  trackedEmbedDocuments: (_op: string, _t: string[], fn: () => Promise<unknown>) => fn(),
  trackedEmbedQuery: (_op: string, _q: string, fn: () => Promise<unknown>) => fn(),
}));

const vec = (n: number) => Array(n).fill(0.1);

describe('RAG embedding dimensions', () => {
  beforeEach(() => {
    vi.resetModules();
    embeddingsCtorArgs.length = 0;
    updates.length = 0;
    inserts.length = 0;
    mockEmbedDocuments.mockReset();
    mockEmbedQuery.mockReset();
    mockRpc.mockReset();
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.EMBEDDING_DIMENSIONS;
  });

  it('asks Gemini for 768-dim vectors to match the vector(768) column', async () => {
    mockEmbedDocuments.mockResolvedValue([vec(768)]);
    const { embedDocument } = await import('../src/rag.js');

    const result = await embedDocument('doc-1', 'deal-1', 'Revenue grew 20% last year.');

    expect(embeddingsCtorArgs[0].outputDimensionality).toBe(768);
    expect(result).toEqual({ success: true, chunkCount: 1 });
    expect(inserts).toHaveLength(1);
    expect(updates.at(-1).embeddingStatus).toBe('completed');
  });

  it('honours EMBEDDING_DIMENSIONS when the column is resized', async () => {
    process.env.EMBEDDING_DIMENSIONS = '1536';
    mockEmbedDocuments.mockResolvedValue([vec(1536)]);
    const { embedDocument } = await import('../src/rag.js');

    await embedDocument('doc-1', 'deal-1', 'Some text.');

    expect(embeddingsCtorArgs[0].outputDimensionality).toBe(1536);
  });

  it('fails the document without inserting chunks when the model returns the wrong width', async () => {
    mockEmbedDocuments.mockResolvedValue([vec(3072)]);
    const { embedDocument } = await import('../src/rag.js');

    const result = await embedDocument('doc-1', 'deal-1', 'Some text.');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/got 3072, column expects 768/);
    expect(inserts).toHaveLength(0);
    expect(updates.at(-1).embeddingStatus).toBe('failed');
  });

  it('searches with a 768-dim query vector', async () => {
    mockEmbedQuery.mockResolvedValue(vec(768));
    mockRpc.mockResolvedValue({
      data: [{ id: 'c1', documentId: 'doc-1', dealId: 'deal-1', content: 'hit', similarity: 0.9, metadata: {} }],
      error: null,
    });
    const { searchDocumentChunks } = await import('../src/rag.js');

    const results = await searchDocumentChunks('revenue', 'deal-1');

    expect(results).toHaveLength(1);
    const sent = mockRpc.mock.calls[0][1].query_embedding as string;
    expect(JSON.parse(sent)).toHaveLength(768);
  });

  it('skips the RPC when the query vector is the wrong width', async () => {
    mockEmbedQuery.mockResolvedValue(vec(3072));
    const { searchDocumentChunks } = await import('../src/rag.js');

    expect(await searchDocumentChunks('revenue', 'deal-1')).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// Spreadsheet-style text has few sentence endings; sentence-only splitting
// produced chunks far over the embedding model's input limit, so whole
// workbooks failed to embed (2026-10-13: 177 of 368 documents).
describe('chunkText caps chunk size on text without sentence breaks', () => {
  it('splits a 266K-char table dump into chunks within the token budget', async () => {
    const { chunkText } = await import('../src/rag.js');
    const row = 'Revenue 1,234,567 2,345,678 3,456,789 | COGS 456,789 567,890 678,901\n';
    const text = row.repeat(3800); // ~266K chars, no ". " anywhere
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(100);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(2000);
    expect(chunks.map((c) => c.content).join(' ').length).toBeGreaterThan(text.length * 0.95);
  });

  it('still packs normal prose by sentence', async () => {
    const { chunkText } = await import('../src/rag.js');
    const chunks = chunkText('First sentence. Second sentence! Third one?', 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('First sentence. Second sentence! Third one?');
  });
});

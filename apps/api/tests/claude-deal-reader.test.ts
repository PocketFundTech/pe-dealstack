/**
 * claudeDealReader tests (INGEST_ENGINE=claude native deal-level read).
 * ai/client is mocked; finalizeExtractedDealData is REAL, so confidence
 * capping / review semantics are exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let nextText: string;
let throwNext: Error | null = null;
const uploadMock = vi.fn(async () => ({ id: 'file_dr_1' }));
const deleteMock = vi.fn(async () => ({ id: 'file_dr_1', type: 'file_deleted' as const }));

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    if (throwNext) { const e = throwNext; throwNext = null; throw e; }
    return { text: nextText, model: 'claude-fable-5', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
  }),
  AIRefusalError: class AIRefusalError extends Error { category = 'test'; },
  getAnthropicClient: vi.fn(() => ({ beta: { files: { upload: uploadMock, delete: deleteMock } } })),
}));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function rawResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    companyName: { value: 'Luktara Industries', confidence: 95, source: 'cover page' },
    industry: { value: 'Specialty Chemicals', confidence: 90, source: 'p2' },
    description: { value: 'A specialty chemicals maker.', confidence: 90 },
    currency: 'USD',
    revenue: { value: 160, confidence: 90, source: 'FY24 revenue $160M' },
    ebitda: { value: 28, confidence: 88, source: 'FY24 EBITDA' },
    ebitdaMargin: { value: 17.5, confidence: 85 },
    revenueGrowth: { value: 12, confidence: 80, source: 'yoy' },
    employees: { value: 300, confidence: 70 },
    foundedYear: { value: 1998, confidence: 80 },
    headquarters: { value: 'Houston, TX', confidence: 85 },
    dealSize: { value: 120, confidence: 75, source: 'asking price' },
    keyRisks: ['customer concentration'],
    investmentHighlights: ['sticky revenue'],
    summary: 'A solid specialty chemicals business.',
    ...overrides,
  });
}

beforeEach(() => {
  calls.length = 0;
  throwNext = null;
  nextText = rawResponse();
  uploadMock.mockClear();
  deleteMock.mockClear();
});

async function getReader() {
  const mod = await import('../src/services/extraction/claudeDealReader.js');
  return mod.readDealDocument;
}

describe('readDealDocument — PDF (native) mode', () => {
  it('uploads the PDF, references it by file_id, and cleans up after', async () => {
    const read = await getReader();
    const out = await read({
      fileBuffer: Buffer.from('%PDF-fake'),
      fileName: 'cim.pdf',
      sourceLength: 120_000,
    });
    expect(out).not.toBeNull();
    expect(out!.companyName.value).toBe('Luktara Industries');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const req = calls[0];
    expect(req.operation).toBe('deal_ingest');
    expect(req.role).toBe('extraction');
    expect(req.extraBetas).toContain('files-api-2025-04-14');
    const content = req.messages[0].content;
    expect(content.some((b: any) => b.type === 'document' && b.source?.file_id === 'file_dr_1')).toBe(true);
    // Standard-length hint for a real text layer.
    expect(content.some((b: any) => typeof b.text === 'string' && b.text.includes('STANDARD-length'))).toBe(true);
  });

  it('scanned PDF (sourceLength≈0): proceeds natively, skips the short-doc confidence cap', async () => {
    nextText = rawResponse(); // revenue confidence 90
    const read = await getReader();
    const out = await read({ fileBuffer: Buffer.from('%PDF-scan'), fileName: 'scan.pdf', sourceLength: 0 });
    expect(out).not.toBeNull();
    // Without nativeFullDocument handling, sourceLength 0 would cap revenue
    // confidence at 60 (short-doc teaser guard) — the native read must not.
    expect(out!.revenue.confidence).toBe(90);
    const content = calls[0].messages[0].content;
    expect(content.some((b: any) => typeof b.text === 'string' && b.text.includes('COMPLETE document file is attached natively'))).toBe(true);
  });

  it('returns null on upload failure without calling the model', async () => {
    uploadMock.mockRejectedValueOnce(new Error('files down'));
    const read = await getReader();
    const out = await read({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', sourceLength: 5000 });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('returns null (and still cleans up) when the model call fails', async () => {
    throwNext = new Error('500 upstream');
    const read = await getReader();
    const out = await read({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', sourceLength: 5000 });
    expect(out).toBeNull();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on unparseable model output', async () => {
    nextText = 'not json at all';
    const read = await getReader();
    const out = await read({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', sourceLength: 5000 });
    expect(out).toBeNull();
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });
});

describe('readDealDocument — text mode', () => {
  it('sends full wrapped text without any file upload, applying the short-doc cap for teasers', async () => {
    nextText = rawResponse(); // model claims 90 confidence on revenue
    const read = await getReader();
    const teaser = 'Teaser: revenue of $160M …' + 'x'.repeat(1000);
    const out = await read({ fileName: 'teaser.docx', fullText: teaser, sourceLength: teaser.length });
    expect(out).not.toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
    // Short doc (<5000 chars): finalize caps financial-field confidence at 60.
    expect(out!.revenue.confidence).toBe(60);
    expect(out!.needsReview).toBe(true);
    const content = calls[0].messages[0].content;
    expect(content.some((b: any) => typeof b.text === 'string' && b.text.includes('SHORT document'))).toBe(true);
  });

  it('caps oversized text at 200k chars (vs the legacy 20k truncation)', async () => {
    const read = await getReader();
    const big = 'y'.repeat(300_000);
    await read({ fileName: 'big.txt', fullText: big, sourceLength: big.length });
    const textBlock = calls[0].messages[0].content.find((b: any) => typeof b.text === 'string' && b.text.length > 10_000);
    expect(textBlock.text.length).toBeLessThan(210_000); // 200k + wrapper overhead
    expect(textBlock.text.length).toBeGreaterThan(190_000);
  });

  it('returns null for near-empty text input', async () => {
    const read = await getReader();
    const out = await read({ fileName: 'tiny.txt', fullText: 'hi', sourceLength: 2 });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

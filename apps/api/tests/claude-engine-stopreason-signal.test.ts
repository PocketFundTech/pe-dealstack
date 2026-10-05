/**
 * Two claudeEngine behaviors not covered by claude-engine.test.ts:
 *  1. A response cut short (stop_reason max_tokens / pause_turn) must be
 *     treated as a failed extraction with an explicit warning log, not
 *     silently handed to JSON.parse (which either throws — logged as a
 *     generic "not valid JSON" with no indication of *why* — or, worse,
 *     parses a truncated-but-still-valid-looking JSON fragment).
 *  2. The caller's AbortSignal (threaded down from the agent's
 *     runWithAgentBounds timeout) must reach trackedClaudeMessage so an
 *     aborted run actually cancels the in-flight Anthropic call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: any[] = [];
let nextStopReason = 'end_turn';
const uploadMock = vi.fn(async () => ({ id: 'file_test123' }));
const deleteMock = vi.fn(async () => ({ id: 'file_test123', type: 'file_deleted' as const }));

vi.mock('../src/services/ai/client.js', () => ({
  trackedClaudeMessage: vi.fn(async (opts: any) => {
    calls.push(opts);
    return {
      text: '{"statements":[],"overallConfidence":0,"warnings":[]}',
      model: 'claude-fable-5',
      stopReason: nextStopReason,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }),
  AIRefusalError: class AIRefusalError extends Error {},
  getAnthropicClient: vi.fn(() => ({
    beta: { files: { upload: uploadMock, delete: deleteMock } },
  })),
}));

const extractTextFromExcelMock = vi.fn();
vi.mock('../src/services/excelFinancialExtractor.js', () => ({
  extractTextFromExcel: (...args: any[]) => extractTextFromExcelMock(...args),
}));

beforeEach(() => {
  calls.length = 0;
  nextStopReason = 'end_turn';
  uploadMock.mockClear();
  deleteMock.mockClear();
  extractTextFromExcelMock.mockReset();
  extractTextFromExcelMock.mockReturnValue('Income Statement\nRevenue 2023 100\n' + 'x'.repeat(200));
});

async function getEngine() {
  const mod = await import('../src/services/extraction/claudeEngine.js');
  return mod.extractWithClaude;
}

describe('extractWithClaude — early stop_reason handling', () => {
  it('treats stop_reason=max_tokens as a failed extraction, not a JSON-parse attempt', async () => {
    nextStopReason = 'max_tokens';
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).toBeNull();
    expect(calls).toHaveLength(1); // no repair pass attempted off a null first-pass result
  });

  it('treats stop_reason=pause_turn as a failed extraction', async () => {
    nextStopReason = 'pause_turn';
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).toBeNull();
  });

  it('still succeeds normally when stop_reason is end_turn', async () => {
    nextStopReason = 'end_turn';
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).not.toBeNull();
  });
});

describe('extractWithClaude — AbortSignal plumbing', () => {
  it('forwards the signal argument into trackedClaudeMessage', async () => {
    const extractWithClaude = await getEngine();
    const controller = new AbortController();
    await extractWithClaude(
      { fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' },
      controller.signal,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('works with no signal passed (optional parameter, back-compat)', async () => {
    const extractWithClaude = await getEngine();
    const out = await extractWithClaude({ fileBuffer: Buffer.from('%PDF-fake'), fileName: 'cim.pdf', fileType: 'pdf' });
    expect(out).not.toBeNull();
    expect(calls[0].signal).toBeUndefined();
  });
});

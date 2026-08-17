/**
 * runIngestDeepPass tests — the post-ingest background financial extraction
 * + auto-score hook (fired via runInBackground from ingest-upload.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runFinancialAgent = vi.fn();
vi.mock('../src/services/agents/financialAgent/index.js', () => ({ runFinancialAgent }));

const acquireExtractionSlot = vi.fn(() => true);
const releaseExtractionSlot = vi.fn();
vi.mock('../src/services/agents/financialAgent/concurrency.js', () => ({
  acquireExtractionSlot: (...a: any[]) => acquireExtractionSlot(...a),
  releaseExtractionSlot: (...a: any[]) => releaseExtractionSlot(...a),
}));

const maybeScoreAfterExtraction = vi.fn(async () => {});
vi.mock('../src/services/agents/dealScorecard/index.js', () => ({
  maybeScoreAfterExtraction: (...a: any[]) => maybeScoreAfterExtraction(...a),
}));

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const okAgentResult = {
  status: 'completed',
  statementIds: ['s1', 's2'],
  periodsStored: 3,
  overallConfidence: 88,
};

beforeEach(() => {
  vi.clearAllMocks();
  acquireExtractionSlot.mockReturnValue(true);
  runFinancialAgent.mockResolvedValue(okAgentResult);
});

async function getService() {
  return await import('../src/services/ingestDeepPass.js');
}

const baseInput = {
  dealId: 'deal-1',
  orgId: 'org-1',
  documentId: 'doc-1',
  fileBuffer: Buffer.from('%PDF'),
  fileName: 'cim.pdf',
  mimeType: 'application/pdf',
};

describe('shouldRunIngestDeepPass', () => {
  it('runs for PDFs and spreadsheets, skips other types', async () => {
    const { shouldRunIngestDeepPass } = await getService();
    expect(shouldRunIngestDeepPass('application/pdf', 'cim.pdf')).toBe(true);
    expect(shouldRunIngestDeepPass('text/csv', 'fin.csv')).toBe(true);
    expect(shouldRunIngestDeepPass('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'model.xlsx')).toBe(true);
    expect(shouldRunIngestDeepPass('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx')).toBe(false);
    expect(shouldRunIngestDeepPass('text/plain', 'notes.txt')).toBe(false);
  });
});

describe('runIngestDeepPass', () => {
  it('runs the financial agent with the in-memory buffer, then auto-scores', async () => {
    const { runIngestDeepPass } = await getService();
    await runIngestDeepPass(baseInput);
    expect(runFinancialAgent).toHaveBeenCalledWith({
      dealId: 'deal-1',
      documentId: 'doc-1',
      fileBuffer: baseInput.fileBuffer,
      fileName: 'cim.pdf',
      fileType: 'pdf',
      organizationId: 'org-1',
    });
    expect(releaseExtractionSlot).toHaveBeenCalledWith('org-1');
    expect(maybeScoreAfterExtraction).toHaveBeenCalledWith('deal-1', 'org-1');
  });

  it('detects spreadsheets as fileType excel', async () => {
    const { runIngestDeepPass } = await getService();
    await runIngestDeepPass({ ...baseInput, fileName: 'model.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(runFinancialAgent.mock.calls[0][0].fileType).toBe('excel');
  });

  it('skips entirely (no agent, no score) when the org is at the concurrency cap', async () => {
    acquireExtractionSlot.mockReturnValue(false);
    const { runIngestDeepPass } = await getService();
    await runIngestDeepPass(baseInput);
    expect(runFinancialAgent).not.toHaveBeenCalled();
    expect(maybeScoreAfterExtraction).not.toHaveBeenCalled();
    expect(releaseExtractionSlot).not.toHaveBeenCalled(); // never acquired
  });

  it('swallows agent failures, releases the slot, and does not score', async () => {
    runFinancialAgent.mockRejectedValueOnce(new Error('extraction blew up'));
    const { runIngestDeepPass } = await getService();
    await expect(runIngestDeepPass(baseInput)).resolves.toBeUndefined();
    expect(releaseExtractionSlot).toHaveBeenCalledWith('org-1');
    expect(maybeScoreAfterExtraction).not.toHaveBeenCalled();
  });

  it('does not score when the agent completes without success', async () => {
    runFinancialAgent.mockResolvedValueOnce({ ...okAgentResult, status: 'failed' });
    const { runIngestDeepPass } = await getService();
    await runIngestDeepPass(baseInput);
    expect(maybeScoreAfterExtraction).not.toHaveBeenCalled();
  });
});

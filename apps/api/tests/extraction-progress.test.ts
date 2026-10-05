/** QA #12 follow-up: per-document "Extract all" progress, readable from any instance. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;
let docs: Row[] = [];
let columnExists = true;
vi.mock('../src/supabase.js', () => ({
  supabase: {
    from: () => ({
      update: (patch: Row) => ({
        in: async (_k: string, ids: string[]) => {
          if (!columnExists) return { error: { code: 'PGRST204', message: "Could not find the 'financialExtraction' column" } };
          for (const d of docs) if (ids.includes(d.id)) Object.assign(d, patch);
          return { error: null };
        },
      }),
      select: () => ({ eq: async (_k: string, dealId: string) => ({ data: docs.filter((d) => d.dealId === dealId), error: null }) }),
    }),
  },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const { setDocExtraction, getRunProgress, resetExtractionProgressProbe } = await import('../src/services/extractionProgress.js');

beforeEach(() => {
  docs = [
    { id: 'a', dealId: 'd1', name: 'P&L.xlsx' },
    { id: 'b', dealId: 'd1', name: 'BS.xlsx' },
    { id: 'c', dealId: 'd1', name: 'CF.xlsx' },
    { id: 'old', dealId: 'd1', name: 'Old.pdf', financialExtraction: { runId: 'previous-run', status: 'done' } },
  ];
  columnExists = true;
  resetExtractionProgressProbe();
});

describe('extraction progress', () => {
  it('reports done / running counts for one run only', async () => {
    await setDocExtraction(['a', 'b', 'c'], 'run-12345', 'queued');
    await setDocExtraction(['a'], 'run-12345', 'done', { periodsStored: 4 });
    await setDocExtraction(['b'], 'run-12345', 'running');
    const p = await getRunProgress('d1', 'run-12345');
    expect(p).toMatchObject({ available: true, total: 3, done: 1, running: ['BS.xlsx'] });
  });

  it('counts failed documents as finished', async () => {
    await setDocExtraction(['a', 'b'], 'run-abcdef', 'queued');
    await setDocExtraction(['a'], 'run-abcdef', 'failed', { error: 'timeout' });
    expect((await getRunProgress('d1', 'run-abcdef')).done).toBe(1);
  });

  it('is a no-op without a runId, and stops writing once the column is known missing', async () => {
    await setDocExtraction(['a'], undefined, 'running');
    expect(docs[0].financialExtraction).toBeUndefined();
    columnExists = false;
    await expect(setDocExtraction(['a'], 'run-12345', 'running')).resolves.toBeUndefined();
    columnExists = true;
    await setDocExtraction(['a'], 'run-12345', 'running'); // skipped: probe remembered the missing column
    expect(docs[0].financialExtraction).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const addFileToDeal = vi.fn();
vi.mock('../src/services/documentStore.js', () => ({ addFileToDeal: (...a: unknown[]) => addFileToDeal(...a) }));

import { enqueueAttachments, drainFileQueue, skipWithReason, mergeNotes, MIGRATION_PENDING_NOTE, QUEUE_WRITE_NOTE } from '../src/services/hubspot/fileQueue.js';
import { HubSpotScopeError } from '../src/services/hubspot/client.js';
import type { ImportCounters } from '../src/services/hubspot/types.js';

const counters = (): ImportCounters => ({ processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 });
const pdfMeta = { id: 'f1', name: 'CIM', extension: 'pdf', size: 1000 };

function client(overrides: Partial<Record<'getFileMeta' | 'getFileSignedUrl' | 'downloadSignedUrl', unknown>> = {}) {
  return {
    getFileMeta: vi.fn(async () => pdfMeta),
    getFileSignedUrl: vi.fn(async () => 'https://signed'),
    downloadSignedUrl: vi.fn(async () => Buffer.from('%PDF')),
    ...overrides,
  } as never;
}

beforeEach(() => {
  chain.calls.length = 0;
  resolver = () => undefined;
  addFileToDeal.mockReset().mockResolvedValue({ outcome: 'created', documentId: 'doc-1' });
});

describe('skipWithReason / mergeNotes', () => {
  it('counts a skip as processed with its reason', () => {
    const c = counters();
    skipWithReason(c, 'no_deal', 2);
    skipWithReason(c, 'no_deal');
    expect(c).toMatchObject({ skipped: 3, processed: 3, reasons: { no_deal: 3 } });
  });
  it('appends notes once, keeping existing ones', () => {
    expect(mergeNotes('emails: 403', ['owners: x', 'owners: x'])).toBe('emails: 403 | owners: x');
    expect(mergeNotes('a | b', ['b'])).toBe('a | b');
    expect(mergeNotes(null, [])).toBeNull();
  });
});

describe('enqueueAttachments', () => {
  it('queues every deal × file pair, ignoring duplicates', async () => {
    expect(await enqueueAttachments({ jobId: 'j', orgId: 'o', dealIds: ['d1', 'd2'], fileIds: ['f1'], engagementId: 'n1' })).toBe(true);
    const op = chain.calls.find((c) => c.table === 'HubSpotFileQueue')!;
    expect(op.action).toBe('upsert');
    expect(op.payload).toEqual([
      { jobId: 'j', organizationId: 'o', dealId: 'd1', hubspotFileId: 'f1', sourceEngagementId: 'n1' },
      { jobId: 'j', organizationId: 'o', dealId: 'd2', hubspotFileId: 'f1', sourceEngagementId: 'n1' },
    ]);
  });
  it('returns false (does not throw) when the table is missing', async () => {
    resolver = () => ({ error: { message: 'relation "HubSpotFileQueue" does not exist' } });
    expect(await enqueueAttachments({ jobId: 'j', orgId: 'o', dealIds: ['d1'], fileIds: ['f1'], engagementId: 'n1' })).toBe(false);
  });
});

describe('drainFileQueue', () => {
  const base = { jobId: 'j', orgId: 'o', uploadedBy: 'u1' };

  it('sets the total on first run (queued + already processed) and imports a file', async () => {
    resolver = (op) => {
      if (op.table === 'HubSpotFileQueue' && op.selectOptions?.head) return { count: 2 };
      if (op.table === 'HubSpotFileQueue' && op.action === 'select') return { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] };
      return undefined;
    };
    const c = counters();
    skipWithReason(c, 'no_deal', 1);
    const r = await drainFileQueue({ ...base, client: client(), counts: c });
    expect(c.total).toBe(3);
    expect(r).toEqual({ done: false, note: null });
    expect(addFileToDeal).toHaveBeenCalledWith({
      dealId: 'd1', filename: 'CIM.pdf', buffer: Buffer.from('%PDF'), mimeType: 'application/pdf',
      uploadedBy: 'u1', hubspotFileId: 'f1',
    });
    expect(c).toMatchObject({ created: 1, processed: 2 });
    const upd = chain.calls.find((x) => x.table === 'HubSpotFileQueue' && x.action === 'update');
    expect(upd?.payload).toEqual({ status: 'done', reason: null, documentId: 'doc-1' });
  });

  it('done when nothing is pending', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head ? { data: [] } : { count: 0 });
    expect(await drainFileQueue({ ...base, client: client(), counts: counters() })).toEqual({ done: true, note: null });
  });

  it('reports a pending migration when attachments were seen', async () => {
    resolver = () => ({ error: { message: 'relation does not exist' } });
    const c = counters();
    skipWithReason(c, 'no_deal', 1);
    expect(await drainFileQueue({ ...base, client: client(), counts: c })).toEqual({ done: true, note: MIGRATION_PENDING_NOTE });
  });

  it('a missing queue table with no attachments seen is a clean finish, not a note', async () => {
    resolver = () => ({ error: { message: 'relation does not exist' } });
    expect(await drainFileQueue({ ...base, client: client(), counts: counters() })).toEqual({ done: true, note: null });
  });

  it('a file already imported for the deal makes no HubSpot calls', async () => {
    resolver = (op) => {
      if (op.table === 'HubSpotFileQueue' && op.selectOptions?.head) return { count: 1 };
      if (op.table === 'HubSpotFileQueue' && op.action === 'select') return { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] };
      if (op.table === 'Document' && op.action === 'select') return { data: { id: 'doc-existing' } };
      return undefined;
    };
    const cl = client();
    const c = counters();
    await drainFileQueue({ ...base, client: cl, counts: c });
    const k = cl as unknown as Record<string, { mock: { calls: unknown[] } }>;
    expect(k.getFileMeta.mock.calls).toHaveLength(0);
    expect(k.getFileSignedUrl.mock.calls).toHaveLength(0);
    expect(k.downloadSignedUrl.mock.calls).toHaveLength(0);
    expect(addFileToDeal).not.toHaveBeenCalled();
    expect(c).toMatchObject({ updated: 1, created: 0, processed: 1 });
    expect(chain.calls.find((x) => x.table === 'HubSpotFileQueue' && x.action === 'update')?.payload)
      .toMatchObject({ status: 'done', documentId: 'doc-existing' });
  });

  it('skips files over the size limit before downloading', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] } : { count: 1 });
    const cl = client({ getFileMeta: vi.fn(async () => ({ ...pdfMeta, size: 500 * 1024 * 1024 })) });
    const c = counters();
    await drainFileQueue({ ...base, client: cl, counts: c });
    expect((cl as { getFileSignedUrl: ReturnType<typeof vi.fn> }).getFileSignedUrl).not.toHaveBeenCalled();
    expect(c.reasons).toEqual({ too_large: 1 });
  });

  it('skips file types Avise does not accept', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] } : { count: 1 });
    const c = counters();
    await drainFileQueue({ ...base, client: client({ getFileMeta: vi.fn(async () => ({ ...pdfMeta, extension: 'pptx' })) }), counts: c });
    expect(c.reasons).toEqual({ unsupported_type: 1 });
    expect(addFileToDeal).not.toHaveBeenCalled();
  });

  it('on a missing scope: skips all remaining files and says which scopes', async () => {
    resolver = (op) => {
      if (op.table === 'HubSpotFileQueue' && op.action === 'update') return { count: 4 };
      if (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head) {
        return { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] };
      }
      return { count: 4 };
    };
    const c = counters();
    const r = await drainFileQueue({
      ...base, counts: c,
      client: client({ getFileMeta: vi.fn(async () => { throw new HubSpotScopeError('files, files.ui_hidden.read', 403); }) }),
    });
    expect(r.done).toBe(true);
    expect(r.note).toContain('files, files.ui_hidden.read');
    expect(c.reasons).toEqual({ missing_scope: 4 });
  });

  it('a failing file is marked failed and the drain continues', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }, { id: 'q2', dealId: 'd1', hubspotFileId: 'f2' }] } : { count: 2 });
    addFileToDeal.mockRejectedValueOnce(new Error('Storage upload failed: x')).mockResolvedValueOnce({ outcome: 'existing', documentId: 'doc-2' });
    const c = counters();
    await drainFileQueue({ ...base, client: client(), counts: c });
    expect(c).toMatchObject({ failed: 1, updated: 1, processed: 2 });
  });

  it('stops at the time budget and leaves the rest pending', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }, { id: 'q2', dealId: 'd1', hubspotFileId: 'f2' }] } : { count: 2 });
    let t = 0;
    const r = await drainFileQueue({ ...base, client: client(), counts: counters(), budgetMs: 10, now: () => (t += 20) });
    expect(r).toEqual({ done: false, note: null });
    expect(addFileToDeal).toHaveBeenCalledTimes(0);
  });

  const oneRow = (op: ChainOp): ChainResult | undefined =>
    op.table === 'HubSpotFileQueue' && op.action === 'select' && !op.selectOptions?.head
      ? { data: [{ id: 'q1', dealId: 'd1', hubspotFileId: 'f1' }] } : { count: 1 };

  it('stops with a note when the queue row cannot be updated, without counting it', async () => {
    resolver = (op) => (op.table === 'HubSpotFileQueue' && op.action === 'update' ? { error: { message: 'boom' } } : oneRow(op));
    const c = counters();
    const r = await drainFileQueue({ ...base, client: client(), counts: c });
    expect(r).toEqual({ done: true, note: QUEUE_WRITE_NOTE });
    expect(c).toMatchObject({ created: 0, updated: 0, processed: 0, failed: 0 });
  });

  it('marks a file failed when its import exceeds the per-file deadline', async () => {
    resolver = oneRow;
    const c = counters();
    await drainFileQueue({ ...base, counts: c, fileDeadlineMs: 5, client: client({ getFileMeta: vi.fn(() => new Promise(() => {})) }) });
    expect(c).toMatchObject({ failed: 1, processed: 1 });
    const upd = chain.calls.find((x) => x.table === 'HubSpotFileQueue' && x.action === 'update');
    expect((upd?.payload as { status: string; reason: string }).status).toBe('failed');
    expect((upd?.payload as { reason: string }).reason).toContain('timed out');
  });

  it('skips a file over 25MB even when under the PDF limit', async () => {
    resolver = oneRow;
    const cl = client({ getFileMeta: vi.fn(async () => ({ ...pdfMeta, size: 30 * 1024 * 1024 })) });
    const c = counters();
    await drainFileQueue({ ...base, client: cl, counts: c });
    expect(c.reasons).toEqual({ too_large: 1 });
    expect((cl as { getFileSignedUrl: ReturnType<typeof vi.fn> }).getFileSignedUrl).not.toHaveBeenCalled();
  });

  it('skips as too_large when the download exceeds the cap', async () => {
    resolver = oneRow;
    const c = counters();
    await drainFileQueue({ ...base, client: client({ downloadSignedUrl: vi.fn(async () => null) }), counts: c });
    expect(c.reasons).toEqual({ too_large: 1 });
    expect(addFileToDeal).not.toHaveBeenCalled();
  });
});

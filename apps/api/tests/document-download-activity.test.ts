/** QA #19: downloads must reach the deal's activity timeline (Activity table). */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserts: any[] = [];
let failInsert = false;
vi.mock('../src/supabase.js', () => ({
  supabase: { from: () => ({ insert: async (row: any) => { inserts.push(row); return { error: failInsert ? { message: 'boom' } : null }; } }) },
}));
vi.mock('../src/utils/logger.js', () => ({ log: { info() {}, warn() {}, error() {}, debug() {} } }));
const { recordDocumentDownload } = await import('../src/services/documentActivity.js');

beforeEach(() => { inserts.length = 0; failInsert = false; });

describe('recordDocumentDownload', () => {
  it('writes a DOCUMENT_DOWNLOADED Activity row on the deal', async () => {
    await recordDocumentDownload({ dealId: 'd1', documentId: 'doc1', documentName: 'P&L.xlsx', by: 'ana@firm.com', via: 'app', watermarked: false });
    expect(inserts).toEqual([expect.objectContaining({
      dealId: 'd1', type: 'DOCUMENT_DOWNLOADED', title: 'Document downloaded: P&L.xlsx', description: 'Downloaded by ana@firm.com',
    })]);
  });

  it('labels share-link downloads', async () => {
    await recordDocumentDownload({ dealId: 'd1', documentId: 'doc1', documentName: 'CIM.pdf', by: 'Buyer A', via: 'share_link' });
    expect(inserts[0].description).toBe('Downloaded via share link (Buyer A)');
  });

  it('skips documents with no deal, and never throws when the insert fails', async () => {
    await recordDocumentDownload({ dealId: null, documentId: 'x', documentName: 'x', by: 'a', via: 'app' });
    expect(inserts).toHaveLength(0);
    failInsert = true;
    await expect(recordDocumentDownload({ dealId: 'd1', documentId: 'x', documentName: 'x', by: 'a', via: 'app' })).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSupabaseChainMock, filterValue, type ChainOp, type ChainResult } from './helpers/supabaseChainMock';

let resolver: (op: ChainOp) => ChainResult | undefined = () => undefined;
const chain = makeSupabaseChainMock((op) => resolver(op));
vi.mock('../src/supabase.js', () => ({ supabase: { from: (t: string) => chain.from(t) } }));
vi.mock('../src/utils/logger.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const listPage = vi.fn();
const listOwners = vi.fn();
vi.mock('../src/services/hubspot/client.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/client.js')>();
  return {
    ...real,
    HubSpotClient: vi.fn().mockImplementation(function () {
      return {
        listPage, listOwners,
        listPropertyNames: vi.fn(async () => ['dealname']),
        listDealStageLabels: vi.fn(async () => ({})),
        countObjects: vi.fn(async () => null),
      };
    }),
  };
});
const upsertByHubspotId = vi.fn(async () => 'created');
vi.mock('../src/services/hubspot/dedup.js', () => ({
  upsertByHubspotId: (...a: unknown[]) => upsertByHubspotId(...a),
  upsertContactInteractionByHubspotId: vi.fn(async () => 'created'),
  upsertDealActivityByHubspotId: vi.fn(async () => 'created'),
}));
vi.mock('../src/services/dealDuplicates.js', () => ({
  loadLiveDealIndex: vi.fn(async () => new Map()),
  normaliseCompanyName: (s: string) => s.toLowerCase(),
}));
const linkDealContacts = vi.fn(async () => 2);
const applyDealOwner = vi.fn(async () => 'set');
vi.mock('../src/services/hubspot/dealRelations.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/dealRelations.js')>();
  return {
    ...real,
    linkDealContacts: (...a: unknown[]) => linkDealContacts(...a),
    applyDealOwner: (...a: unknown[]) => applyDealOwner(...a),
    loadOrgUsersByEmail: vi.fn(async () => new Map([['ann@x.com', 'user-ann']])),
  };
});
const enqueueAttachments = vi.fn(async () => true);
const drainFileQueue = vi.fn();
vi.mock('../src/services/hubspot/fileQueue.js', async (orig) => {
  const real = await orig<typeof import('../src/services/hubspot/fileQueue.js')>();
  return {
    ...real,
    enqueueAttachments: (...a: unknown[]) => enqueueAttachments(...a),
    drainFileQueue: (...a: unknown[]) => drainFileQueue(...a),
  };
});

import { runImportBatch, resetStageLabelCache } from '../src/services/hubspot/importEngine.js';

const ALL = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks', 'files'];
const freshCounts = () => Object.fromEntries(ALL.map((o) => [o, { processed: 0, created: 0, updated: 0, failed: 0, skipped: 0, total: null }]));

function jobRow(currentObject: string, extra: Record<string, unknown> = {}) {
  return { id: 'job-1', organizationId: 'org-1', status: 'running', objectCounts: freshCounts(), currentObject, cursor: null, error: null, startedBy: 'user-starter', ...extra };
}

/** The objectCounts written by the job's final update in this batch. */
function lastJobUpdate() {
  const ups = chain.calls.filter((c) => c.table === 'ImportJob' && c.action === 'update');
  return ups[ups.length - 1]?.payload as Record<string, unknown>;
}

beforeEach(() => {
  chain.calls.length = 0;
  resetStageLabelCache();
  listPage.mockReset();
  listOwners.mockReset().mockResolvedValue([{ id: 'own-1', email: 'Ann@x.com', name: 'Ann Lee' }]);
  upsertByHubspotId.mockClear();
  linkDealContacts.mockClear();
  applyDealOwner.mockClear();
  enqueueAttachments.mockClear();
  drainFileQueue.mockReset();
});

describe('deals phase — relationships', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('deals') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      if (op.table === 'Company') {
        return { data: filterValue(op, 'hubspotId') === 'c-primary' ? { id: 'co-1', name: 'Acme' } : { id: 'co-2', name: 'Beta Holdings' } };
      }
      if (op.table === 'Deal') return { data: { id: 'deal-1' } };
      if (op.table === 'Contact') return { data: { id: `local-${filterValue(op, 'hubspotId')}` } };
      return undefined;
    };
    listPage.mockResolvedValue({
      nextCursor: null,
      results: [{
        id: 'hs-d1',
        properties: { dealname: 'Acme deal', hubspot_owner_id: 'own-1' },
        associations: {
          companies: { results: [{ id: 'c-other', type: 'deal_to_company_unlabeled' }, { id: 'c-primary', type: 'deal_to_company' }] },
          contacts: { results: [{ id: 'p1' }, { id: 'p2' }] },
        },
      }],
    });
  });

  it('uses the primary company and records the others + owner on the HubSpot card', async () => {
    await runImportBatch('job-1', 'tok');
    const [, , , row] = upsertByHubspotId.mock.calls.find((c) => c[0] === 'Deal')!;
    expect(row).toMatchObject({
      companyId: 'co-1',
      hubspotProperties: expect.objectContaining({ hubspot_owner: 'Ann Lee <Ann@x.com>', associated_companies: 'Beta Holdings' }),
    });
  });

  it('links the deal to its contacts and counts the new links', async () => {
    await runImportBatch('job-1', 'tok');
    expect(linkDealContacts).toHaveBeenCalledWith('deal-1', ['local-p1', 'local-p2']);
    expect((lastJobUpdate().objectCounts as Record<string, { contactLinks?: number }>).deals.contactLinks).toBe(2);
  });

  it('matches the owner by email to an Avise user and counts it', async () => {
    await runImportBatch('job-1', 'tok', 'fill');
    expect(applyDealOwner).toHaveBeenCalledWith({ dealId: 'deal-1', ownerUserId: 'user-ann', mode: 'fill' });
    expect((lastJobUpdate().objectCounts as Record<string, { ownersMatched?: number }>).deals.ownersMatched).toBe(1);
  });

  it('owners scope missing: deal still imports, job gets a note naming the scope', async () => {
    const { HubSpotScopeError } = await import('../src/services/hubspot/client.js');
    listOwners.mockRejectedValue(new HubSpotScopeError('crm.objects.owners.read', 403));
    await runImportBatch('job-1', 'tok');
    expect(upsertByHubspotId).toHaveBeenCalled();
    expect(applyDealOwner).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: null }));
    expect(String(lastJobUpdate().error)).toContain('crm.objects.owners.read');
  });

  it('a relationship failure does not fail the deal', async () => {
    linkDealContacts.mockRejectedValueOnce(new Error('ContactDeal link failed: x'));
    await runImportBatch('job-1', 'tok');
    const deals = (lastJobUpdate().objectCounts as Record<string, { failed: number; created: number }>).deals;
    expect(deals).toMatchObject({ failed: 0, created: 1 });
  });
});

describe('engagement phase — attachments', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('notes') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      if (op.table === 'Contact') return { data: { id: 'local-contact' } };
      if (op.table === 'Deal') return { data: filterValue(op, 'hubspotId') === 'hs-deal' ? { id: 'deal-1' } : null };
      return undefined;
    };
  });

  it('queues attachments for the deal even when the note attaches to a contact', async () => {
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n1', properties: { hs_note_body: 'x', hs_attachment_ids: 'f1;f2' },
      associations: { contacts: { results: [{ id: 'pc' }] }, deals: { results: [{ id: 'hs-deal' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    expect(enqueueAttachments).toHaveBeenCalledWith({ jobId: 'job-1', orgId: 'org-1', dealIds: ['deal-1'], fileIds: ['f1', 'f2'], engagementId: 'n1' });
  });

  it('attachments with no deal are skipped with reason no_deal', async () => {
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n2', properties: { hs_attachment_ids: 'f9' },
      associations: { contacts: { results: [{ id: 'pc' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    expect(enqueueAttachments).not.toHaveBeenCalled();
    const files = (lastJobUpdate().objectCounts as Record<string, { skipped: number; reasons?: Record<string, number> }>).files;
    expect(files).toMatchObject({ skipped: 1, reasons: { no_deal: 1 } });
  });

  it('a queue failure never fails the engagement', async () => {
    enqueueAttachments.mockResolvedValueOnce(false);
    listPage.mockResolvedValue({ nextCursor: null, results: [{
      id: 'n3', properties: { hs_attachment_ids: 'f1' },
      associations: { deals: { results: [{ id: 'hs-deal' }] } },
    }] });
    await runImportBatch('job-1', 'tok');
    const c = lastJobUpdate().objectCounts as Record<string, { failed: number }>;
    expect(c.notes.failed).toBe(0);
    expect(c.files.failed).toBe(1);
  });

  it('after tasks, the job moves on to files (not completed)', async () => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('tasks') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      return undefined;
    };
    listPage.mockResolvedValue({ nextCursor: null, results: [] });
    expect(await runImportBatch('job-1', 'tok')).toBe(true);
    expect(lastJobUpdate()).toMatchObject({ currentObject: 'files', status: 'running' });
  });
});

describe('files phase', () => {
  beforeEach(() => {
    resolver = (op) => {
      if (op.table === 'ImportJob' && op.action === 'select') return { data: jobRow('files') };
      if (op.table === 'ImportJob' && op.action === 'update') return { data: { id: 'job-1' } };
      return undefined;
    };
  });

  it('drains with the starter as uploader and keeps going while files remain', async () => {
    drainFileQueue.mockResolvedValue({ done: false, note: null });
    expect(await runImportBatch('job-1', 'tok')).toBe(true);
    expect(drainFileQueue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', orgId: 'org-1', uploadedBy: 'user-starter' }));
    expect(listPage).not.toHaveBeenCalled();
    expect(lastJobUpdate()).toMatchObject({ currentObject: 'files', status: 'running' });
  });

  it('completes the job when the queue is empty and keeps the note', async () => {
    drainFileQueue.mockResolvedValue({ done: true, note: 'files: skipped — scopes' });
    expect(await runImportBatch('job-1', 'tok')).toBe(false);
    expect(lastJobUpdate()).toMatchObject({ status: 'completed', currentObject: null, error: 'files: skipped — scopes' });
  });
});

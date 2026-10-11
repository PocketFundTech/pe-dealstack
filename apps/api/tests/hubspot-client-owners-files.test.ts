import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HubSpotClient, HubSpotScopeError, STANDARD_PROPERTIES } from '../src/services/hubspot/client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('HubSpotClient — owners', () => {
  it('pages through /crm/v3/owners and maps name + email', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ results: [{ id: '1', email: 'a@x.com', firstName: 'Ann', lastName: 'Lee' }], paging: { next: { after: 'p2' } } }))
      .mockResolvedValueOnce(json({ results: [{ id: '2', email: null, firstName: '', lastName: '' }] }));
    const owners = await new HubSpotClient('t').listOwners();
    expect(owners).toEqual([
      { id: '1', email: 'a@x.com', name: 'Ann Lee' },
      { id: '2', email: null, name: null },
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain('/crm/v3/owners?limit=100');
    expect(fetchMock.mock.calls[1][0]).toContain('after=p2');
  });

  it('throws HubSpotScopeError naming the owners scope on 403', async () => {
    fetchMock.mockResolvedValueOnce(json({ category: 'MISSING_SCOPES' }, 403));
    await expect(new HubSpotClient('t').listOwners()).rejects.toMatchObject({
      name: 'HubSpotScopeError', scopes: 'crm.objects.owners.read', status: 403,
    });
  });
});

describe('HubSpotClient — files', () => {
  it('returns file metadata, null on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 'f1', name: 'CIM', extension: 'pdf', size: 1234 }))
      .mockResolvedValueOnce(json({}, 404));
    const c = new HubSpotClient('t');
    expect(await c.getFileMeta('f1')).toEqual({ id: 'f1', name: 'CIM', extension: 'pdf', size: 1234 });
    expect(await c.getFileMeta('gone')).toBeNull();
  });

  it('throws HubSpotScopeError naming both file scopes on 403', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    const err = await new HubSpotClient('t').getFileSignedUrl('f1').catch((e) => e);
    expect(err).toBeInstanceOf(HubSpotScopeError);
    expect(err.scopes).toBe('files, files.ui_hidden.read');
  });

  it('gets a signed URL and downloads it without the bearer token', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ url: 'https://cdn.example/signed' }))
      .mockResolvedValueOnce(new Response(Buffer.from('hello'), { status: 200 }));
    const c = new HubSpotClient('secret');
    const url = await c.getFileSignedUrl('f1');
    expect(url).toBe('https://cdn.example/signed');
    const buf = await c.downloadSignedUrl(url);
    expect(buf.toString()).toBe('hello');
    const downloadInit = fetchMock.mock.calls[1][1] as RequestInit | undefined;
    expect(JSON.stringify(downloadInit ?? {})).not.toContain('secret');
  });
});

describe('HubSpotClient — properties and associations', () => {
  it('requests owner id on deals and attachment ids on every engagement type', () => {
    expect(STANDARD_PROPERTIES.deals).toContain('hubspot_owner_id');
    for (const t of ['notes', 'calls', 'meetings', 'emails', 'tasks'] as const) {
      expect(STANDARD_PROPERTIES[t]).toContain('hs_attachment_ids');
    }
  });

  it('asks for company AND contact associations on deals', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    await new HubSpotClient('t').listPage('deals', { properties: ['dealname'] });
    expect(fetchMock.mock.calls[0][0]).toContain('associations=companies%2Ccontacts');
  });

  it('still asks only for companies on contacts', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [] }));
    await new HubSpotClient('t').listPage('contacts', { properties: ['email'] });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('associations=companies');
    expect(url).not.toContain('contacts%2C');
  });
});

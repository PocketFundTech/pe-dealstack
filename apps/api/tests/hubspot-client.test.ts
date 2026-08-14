import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HubSpotClient, MAX_PROPERTIES, STANDARD_PROPERTIES } from '../src/services/hubspot/client.js';

const mkRes = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('HubSpotClient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('validateToken returns ok with status on 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { total: 3 })));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toEqual({ ok: true, status: 200, category: null });
  });

  it('validateToken surfaces status and category on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(401, { status: 'error', message: 'bad', category: 'INVALID_AUTHENTICATION' })));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toEqual({ ok: false, status: 401, category: 'INVALID_AUTHENTICATION' });
  });

  it('validateToken surfaces MISSING_SCOPES on 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(403, { status: 'error', message: 'no scopes', category: 'MISSING_SCOPES' })));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toEqual({ ok: false, status: 403, category: 'MISSING_SCOPES' });
  });

  it('validateToken tolerates a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
      headers: { get: () => null },
      json: async () => { throw new Error('not json'); },
      text: async () => 'Internal Server Error',
    }));
    const c = new HubSpotClient('tok');
    expect(await c.validateToken()).toEqual({ ok: false, status: 500, category: null });
  });

  it('listPage returns results and next cursor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mkRes(200, { results: [{ id: '1', properties: {} }], paging: { next: { after: '20' } } }),
    ));
    const c = new HubSpotClient('tok');
    const page = await c.listPage('companies', { limit: 20 });
    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBe('20');
  });

  it('retries once after a 429 with Retry-After, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mkRes(429, {}, { 'retry-after': '0' }))
      .mockResolvedValueOnce(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new HubSpotClient('tok');
    const page = await c.listPage('contacts', { limit: 20 });
    expect(page.results).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The 429 backoff sleeps for Retry-After seconds — a value controlled
   * entirely by an external server — inside a Vercel function that is
   * hard-killed at 300s. An uncapped wait (huge Retry-After, or a value
   * denominated in ms instead of seconds) would sleep past the function
   * deadline: lambda killed mid-request, client sees a network error, and
   * the user is back to a stuck "Importing…". The wait must be capped.
   */
  it('caps the 429 backoff wait even when Retry-After is huge', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(mkRes(429, {}, { 'retry-after': '3600' })) // 1 hour
        .mockResolvedValueOnce(mkRes(200, { results: [], paging: undefined }));
      vi.stubGlobal('fetch', fetchMock);
      const c = new HubSpotClient('tok');
      const pending = c.listPage('contacts', { limit: 20 });
      // Advance only 10s — if the wait were the full 3600s, the retry fetch
      // would not have fired yet and this await would hang the test.
      await vi.advanceTimersByTimeAsync(10_000);
      const page = await pending;
      expect(page.results).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HubSpotClient.listPropertyNames', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps custom (hubspotDefined=false) + standard, drops system hs_* / hubspotDefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: [
      { name: 'name', hubspotDefined: true },
      { name: 'fund_vintage', hubspotDefined: false },
      { name: 'sector_focus', hubspotDefined: false },
      { name: 'hs_object_id', hubspotDefined: true },
      { name: 'hubspot_owner_id', hubspotDefined: true },
    ] })));
    const names = await new HubSpotClient('tok').listPropertyNames('companies');
    expect(names).toContain('fund_vintage');
    expect(names).toContain('sector_focus');
    expect(names).toContain('name');
    expect(names).not.toContain('hs_object_id');
    expect(names).not.toContain('hubspot_owner_id');
  });

  it('falls back to the standard set when discovery fails (non-200)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(403, { message: 'no scope' })));
    const names = await new HubSpotClient('tok').listPropertyNames('deals');
    expect(names).toEqual(expect.arrayContaining(['dealname', 'amount']));
  });

  it('caps the list at MAX_PROPERTIES (custom prioritized) without throwing', async () => {
    const many = Array.from({ length: MAX_PROPERTIES + 50 }, (_, i) => ({ name: `custom_${i}`, hubspotDefined: false }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: many })));
    const names = await new HubSpotClient('tok').listPropertyNames('contacts');
    expect(names.length).toBe(MAX_PROPERTIES);
  });
});

describe('HubSpotClient.listPropertyNames — custom-field detection', () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * HubSpot sets hubspotDefined:true on its own built-in properties and OMITS
   * the key entirely on user-created custom properties (the field is optional
   * in HubSpot's own SDK typing). A `=== false` check therefore drops every
   * custom property the client actually cares about.
   */
  it('keeps custom properties when HubSpot omits the hubspotDefined key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: [
      { name: 'name', hubspotDefined: true },
      { name: 'fund_vintage' },   // custom — key absent, not false
      { name: 'sector_focus' },   // custom — key absent, not false
    ] })));
    const names = await new HubSpotClient('tok').listPropertyNames('companies');
    expect(names).toContain('fund_vintage');
    expect(names).toContain('sector_focus');
  });

  it('keeps the standard set when capping at MAX_PROPERTIES', async () => {
    const many = Array.from({ length: MAX_PROPERTIES + 50 }, (_, i) => ({ name: `custom_${i}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: many })));
    const names = await new HubSpotClient('tok').listPropertyNames('contacts');
    expect(names.length).toBe(MAX_PROPERTIES);
    // Standard fields must survive the cap — without them every record imports blank.
    expect(names).toContain('firstname');
    expect(names).toContain('lastname');
    expect(names).toContain('email');
  });
});

describe('STANDARD_PROPERTIES coverage', () => {
  it('requests the deal close date', () => {
    expect(STANDARD_PROPERTIES.deals).toContain('closedate');
  });

  it('requests company location, size and web fields', () => {
    expect(STANDARD_PROPERTIES.companies).toEqual(
      expect.arrayContaining(['website', 'phone', 'city', 'state', 'country', 'numberofemployees', 'annualrevenue', 'lifecyclestage']),
    );
  });

  it('requests contact company, mobile and lifecycle fields', () => {
    expect(STANDARD_PROPERTIES.contacts).toEqual(
      expect.arrayContaining(['company', 'mobilephone', 'lifecyclestage', 'city', 'state', 'country']),
    );
  });
});

describe('HubSpotClient.listPage associations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requests company associations for contacts, not just deals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    await new HubSpotClient('tok').listPage('contacts', { limit: 20 });
    expect(fetchMock.mock.calls[0][0] as string).toContain('associations=companies');
  });
});

describe('HubSpotClient.listDealStageLabels', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('maps HubSpot internal stage ids to their human labels', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200, { results: [
      { label: 'Sales Pipeline', stages: [
        { id: '104512345', label: 'Due Diligence' },
        { id: '104512346', label: 'Closed Won' },
      ] },
    ] })));
    const labels = await new HubSpotClient('tok').listDealStageLabels();
    expect(labels['104512345']).toBe('Due Diligence');
    expect(labels['104512346']).toBe('Closed Won');
  });

  it('returns an empty map when the pipelines call fails, without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(403, { message: 'no scope' })));
    await expect(new HubSpotClient('tok').listDealStageLabels()).resolves.toEqual({});
  });
});

describe('STANDARD_PROPERTIES — engagement types', () => {
  it('requests the note body and timestamp', () => {
    expect(STANDARD_PROPERTIES.notes).toEqual(expect.arrayContaining(['hs_note_body', 'hs_timestamp']));
  });

  it('requests call title, body, duration, and direction', () => {
    expect(STANDARD_PROPERTIES.calls).toEqual(
      expect.arrayContaining(['hs_call_title', 'hs_call_body', 'hs_call_duration', 'hs_call_direction', 'hs_timestamp']),
    );
  });

  it('requests meeting title, body, start/end time, and outcome', () => {
    expect(STANDARD_PROPERTIES.meetings).toEqual(
      expect.arrayContaining(['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome']),
    );
  });

  it('requests email subject, text, and direction', () => {
    expect(STANDARD_PROPERTIES.emails).toEqual(
      expect.arrayContaining(['hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_timestamp']),
    );
  });

  it('requests task subject, body, status, and priority', () => {
    expect(STANDARD_PROPERTIES.tasks).toEqual(
      expect.arrayContaining(['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_timestamp']),
    );
  });
});

describe('HubSpotClient.listPage — engagement contact + deal associations', () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(['notes', 'calls', 'meetings', 'emails', 'tasks'] as const)(
    'requests both contact and deal associations for %s',
    async (type) => {
      const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
      vi.stubGlobal('fetch', fetchMock);
      await new HubSpotClient('tok').listPage(type, { limit: 20 });
      const url = fetchMock.mock.calls[0][0] as string;
      // Regression check: 'associations=contacts,deals' URL-encodes the comma
      // as %2C, so a bare toContain('associations=contacts') is a substring
      // match that passes regardless of whether ',deals' is present at all —
      // it wouldn't catch a regression that dropped deal associations
      // entirely. Assert the full encoded param instead.
      expect(url).toContain('associations=contacts%2Cdeals');
    },
  );
});

describe('HubSpotClient.listPage properties override', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('sends the supplied properties list in the query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    await new HubSpotClient('tok').listPage('companies', { limit: 20, properties: ['name', 'fund_vintage'] });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('properties=name%2Cfund_vintage');
  });
  it('falls back to the standard list when no properties supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { results: [], paging: undefined }));
    vi.stubGlobal('fetch', fetchMock);
    await new HubSpotClient('tok').listPage('companies', { limit: 20 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('properties=name');
  });
});

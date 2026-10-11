import { describe, it, expect } from 'vitest';
import { mapDeal } from '../src/services/hubspot/mappers.js';
import { mapEngagement } from '../src/services/hubspot/engagementMappers.js';
import type { HubSpotRecord } from '../src/services/hubspot/types.js';

const deal = (assoc: HubSpotRecord['associations'], props: Record<string, string | null> = {}): HubSpotRecord => ({
  id: 'd1', properties: { dealname: 'Acme', ...props }, associations: assoc,
});

describe('mapDeal — companies', () => {
  it('picks the company HubSpot marks as primary, not the first one', () => {
    const m = mapDeal(deal({ companies: { results: [
      { id: 'c2', type: 'deal_to_company_unlabeled' },
      { id: 'c1', type: 'deal_to_company' },
      { id: 'c1', type: 'deal_to_company_unlabeled' },
    ] } }));
    expect(m.associatedCompanyHubspotId).toBe('c1');
    expect(m.otherCompanyHubspotIds).toEqual(['c2']);
  });

  it('falls back to the first company when none is labelled primary', () => {
    const m = mapDeal(deal({ companies: { results: [{ id: 'c9' }, { id: 'c8' }] } }));
    expect(m.associatedCompanyHubspotId).toBe('c9');
    expect(m.otherCompanyHubspotIds).toEqual(['c8']);
  });

  it('has no companies when HubSpot returns none', () => {
    const m = mapDeal(deal(undefined));
    expect(m.associatedCompanyHubspotId).toBeNull();
    expect(m.otherCompanyHubspotIds).toEqual([]);
  });
});

describe('mapDeal — contacts and owner', () => {
  it('collects de-duplicated contact ids', () => {
    const m = mapDeal(deal({ contacts: { results: [{ id: 'p1' }, { id: 'p2' }, { id: 'p1' }] } }));
    expect(m.contactHubspotIds).toEqual(['p1', 'p2']);
  });

  it('reads the owner id and keeps the raw id out of hubspotProperties', () => {
    const m = mapDeal(deal(undefined, { hubspot_owner_id: '777' }));
    expect(m.ownerHubspotId).toBe('777');
    expect(m.hubspotProperties).not.toHaveProperty('hubspot_owner_id');
  });

  it('owner is null when unset', () => {
    expect(mapDeal(deal(undefined, { hubspot_owner_id: '' })).ownerHubspotId).toBeNull();
  });
});

describe('mapEngagement — attachments', () => {
  it('splits hs_attachment_ids on semicolons and drops blanks', () => {
    const m = mapEngagement('notes', { id: 'n1', properties: { hs_attachment_ids: '11; 12;;' } });
    expect(m.attachmentIds).toEqual(['11', '12']);
  });

  it('is empty when there are no attachments', () => {
    expect(mapEngagement('calls', { id: 'c1', properties: {} }).attachmentIds).toEqual([]);
  });
});

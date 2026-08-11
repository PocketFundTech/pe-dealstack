import { describe, it, expect } from 'vitest';
import { mapCompany, mapContact, mapDeal, hubspotStageToDealStage } from '../src/services/hubspot/mappers.js';

describe('mapCompany', () => {
  it('maps standard properties and stashes the rest', () => {
    const out = mapCompany({
      id: '101',
      properties: {
        name: 'Acme Corp', industry: 'Manufacturing',
        domain: 'acme.com', description: 'Widgets',
        custom_field_x: 'keep-me',
      },
    });
    expect(out).toEqual({
      hubspotId: '101',
      name: 'Acme Corp',
      industry: 'Manufacturing',
      website: 'acme.com',
      description: 'Widgets',
      hubspotProperties: { custom_field_x: 'keep-me' },
    });
  });

  it('falls back to "Unknown Company" when name missing', () => {
    expect(mapCompany({ id: '1', properties: {} }).name).toBe('Unknown Company');
  });

  it('preserves a client custom property verbatim in hubspotProperties', () => {
    const out = mapCompany({ id: '1', properties: { name: 'Acme', fund_vintage: '2021', sector_focus: 'SaaS' } });
    expect(out.hubspotProperties).toEqual({ fund_vintage: '2021', sector_focus: 'SaaS' });
    expect(out.name).toBe('Acme');
  });
});

describe('mapContact', () => {
  it('maps name/email/title and associated company', () => {
    const out = mapContact(
      { id: '5', properties: { firstname: 'Jane', lastname: 'Doe', email: 'j@x.com', jobtitle: 'CFO', phone: '123' } },
      'Acme Corp',
    );
    expect(out).toMatchObject({
      hubspotId: '5', firstName: 'Jane', lastName: 'Doe',
      email: 'j@x.com', title: 'CFO', phone: '123', company: 'Acme Corp',
    });
  });

  it('defaults blank names to empty string, not null', () => {
    const out = mapContact({ id: '6', properties: {} }, null);
    expect(out.firstName).toBe('');
    expect(out.lastName).toBe('');
    expect(out.company).toBeNull();
  });
});

describe('mapDeal', () => {
  it('maps amount to dealSize and tags source as hubspot', () => {
    const out = mapDeal({
      id: '9',
      properties: { dealname: 'Big Deal', amount: '50000', dealstage: 'qualified', pipeline: 'default' },
      associations: { companies: { results: [{ id: '101' }] } },
    });
    expect(out.name).toBe('Big Deal');
    expect(out.dealSize).toBe(50000);
    expect(out.associatedCompanyHubspotId).toBe('101');
    expect(out.customFields).toMatchObject({ source: 'hubspot', dealstage: 'qualified', pipeline: 'default' });
  });

  it('handles missing amount as null dealSize', () => {
    expect(mapDeal({ id: '9', properties: { dealname: 'X' } }).dealSize).toBeNull();
  });
});

describe('hubspotStageToDealStage', () => {
  it('maps a closed-won label to CLOSED_WON', () => {
    expect(hubspotStageToDealStage('Closed Won')).toBe('CLOSED_WON');
  });

  it('maps a due-diligence label to DUE_DILIGENCE', () => {
    expect(hubspotStageToDealStage('Due Diligence')).toBe('DUE_DILIGENCE');
  });

  it('is case- and punctuation-insensitive', () => {
    expect(hubspotStageToDealStage('closed-lost')).toBe('CLOSED_LOST');
  });

  it('returns null for an unrecognised custom stage rather than guessing', () => {
    expect(hubspotStageToDealStage('Bespoke Client Stage')).toBeNull();
  });

  /**
   * "Pass" is standard M&A screening terminology for an advancing deal
   * ("first pass", "1st pass approval") — the opposite of PASSED (declined).
   * A bare \bpass\b match would misfile an active deal as rejected.
   */
  it('does not treat "First Pass Review" as a declined deal', () => {
    expect(hubspotStageToDealStage('First Pass Review')).not.toBe('PASSED');
  });

  it('does not treat "1st Pass Approval" as a declined deal', () => {
    expect(hubspotStageToDealStage('1st Pass Approval')).not.toBe('PASSED');
  });

  it('still maps an explicit "Passed" stage to PASSED', () => {
    expect(hubspotStageToDealStage('Passed')).toBe('PASSED');
  });

  it('still maps "Declined" and "Rejected" to PASSED', () => {
    expect(hubspotStageToDealStage('Declined')).toBe('PASSED');
    expect(hubspotStageToDealStage('Rejected')).toBe('PASSED');
  });

  it('does not treat "At Risk of Being Lost" as a closed-lost deal', () => {
    expect(hubspotStageToDealStage('At Risk of Being Lost')).not.toBe('CLOSED_LOST');
  });

  it('still maps explicit "Closed Lost" / "Closed Won" correctly', () => {
    expect(hubspotStageToDealStage('Closed Lost')).toBe('CLOSED_LOST');
    expect(hubspotStageToDealStage('Closed Won')).toBe('CLOSED_WON');
  });
});

describe('mapDeal — stage resolution', () => {
  /**
   * Deal.stage defaults to INITIAL_REVIEW at the DB level, so a deal whose
   * HubSpot stage is never mapped silently lands in the wrong pipeline column.
   */
  it('maps a resolved HubSpot stage label onto Deal.stage', () => {
    const out = mapDeal({ id: '9', properties: { dealname: 'X', dealstage: '104512346' } }, 'Closed Won');
    expect(out.stage).toBe('CLOSED_WON');
  });

  it('leaves stage null when the HubSpot stage has no equivalent', () => {
    const out = mapDeal({ id: '9', properties: { dealname: 'X', dealstage: '104512399' } }, 'Bespoke Client Stage');
    expect(out.stage).toBeNull();
  });

  it('stores the readable stage label rather than the raw internal id', () => {
    const out = mapDeal({ id: '9', properties: { dealname: 'X', dealstage: '104512345' } }, 'Due Diligence');
    expect(out.customFields.dealstage).toBe('Due Diligence');
  });
});

describe('mapCompany — web address', () => {
  it('prefers the website property over the bare domain', () => {
    const out = mapCompany({ id: '1', properties: { name: 'Acme', website: 'https://acme.com', domain: 'acme.com' } });
    expect(out.website).toBe('https://acme.com');
  });

  it('falls back to domain when website is absent', () => {
    expect(mapCompany({ id: '1', properties: { name: 'Acme', domain: 'acme.com' } }).website).toBe('acme.com');
  });
});

import { describe, it, expect } from 'vitest';
import { mapEngagement } from '../src/services/hubspot/engagementMappers.js';
import type { HubSpotRecord } from '../src/services/hubspot/types.js';

function rec(properties: Record<string, string | null>, contactIds: string[] = []): HubSpotRecord {
  return {
    id: 'hs-1',
    properties,
    associations: contactIds.length ? { contacts: { results: contactIds.map((id) => ({ id })) } } : undefined,
  };
}

describe('mapEngagement — notes', () => {
  it('maps hs_note_body and hs_timestamp, with no title', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'Called about term sheet', hs_timestamp: '1721000000000' }));
    expect(out).toMatchObject({
      hubspotId: 'hs-1',
      interactionType: 'NOTE',
      title: null,
      description: 'Called about term sheet',
      date: new Date(1721000000000).toISOString(),
    });
  });
});

describe('mapEngagement — calls', () => {
  it('maps title, body, duration, and direction into description', () => {
    const out = mapEngagement('calls', rec({
      hs_call_title: 'Intro call', hs_call_body: 'Discussed valuation',
      hs_call_duration: '332000', hs_call_direction: 'OUTBOUND', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('CALL');
    expect(out.title).toBe('Intro call');
    expect(out.description).toContain('Discussed valuation');
    expect(out.description).toContain('5m 32s');
    expect(out.description).toContain('OUTBOUND');
    expect(out.date).toBe(new Date(1721000000000).toISOString());
  });

  it('omits duration/direction from description when absent', () => {
    const out = mapEngagement('calls', rec({ hs_call_body: 'Quick chat', hs_timestamp: '1721000000000' }));
    expect(out.description).toBe('Quick chat');
  });
});

describe('mapEngagement — meetings', () => {
  it('prefers hs_meeting_start_time over hs_timestamp for the date', () => {
    const out = mapEngagement('meetings', rec({
      hs_meeting_title: 'Diligence session', hs_meeting_body: 'Reviewed financials',
      hs_meeting_outcome: 'COMPLETED', hs_meeting_start_time: '1721000000000', hs_timestamp: '1720000000000',
    }));
    expect(out.interactionType).toBe('MEETING');
    expect(out.title).toBe('Diligence session');
    expect(out.description).toContain('Reviewed financials');
    expect(out.description).toContain('COMPLETED');
    expect(out.date).toBe(new Date(1721000000000).toISOString());
  });

  it('falls back to hs_timestamp when hs_meeting_start_time is absent', () => {
    const out = mapEngagement('meetings', rec({ hs_meeting_title: 'Follow-up', hs_timestamp: '1720000000000' }));
    expect(out.date).toBe(new Date(1720000000000).toISOString());
  });
});

describe('mapEngagement — emails', () => {
  it('maps subject and text', () => {
    const out = mapEngagement('emails', rec({
      hs_email_subject: 'Re: Data room access', hs_email_text: 'Here is the link', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('EMAIL');
    expect(out.title).toBe('Re: Data room access');
    expect(out.description).toBe('Here is the link');
  });
});

describe('mapEngagement — tasks', () => {
  it('prefixes the title with [Task] and folds status/priority into description', () => {
    const out = mapEngagement('tasks', rec({
      hs_task_subject: 'Send NDA', hs_task_body: 'Standard NDA template',
      hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_timestamp: '1721000000000',
    }));
    expect(out.interactionType).toBe('OTHER');
    expect(out.title).toBe('[Task] Send NDA');
    expect(out.description).toContain('Standard NDA template');
    expect(out.description).toContain('NOT_STARTED');
    expect(out.description).toContain('HIGH');
  });

  it('falls back to "Untitled Task" when hs_task_subject is blank', () => {
    const out = mapEngagement('tasks', rec({ hs_timestamp: '1721000000000' }));
    expect(out.title).toBe('[Task] Untitled Task');
  });
});

describe('mapEngagement — associations and missing timestamps', () => {
  it('collects associated contact hubspot ids', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'x' }, ['contact-1', 'contact-2']));
    expect(out.associatedContactHubspotIds).toEqual(['contact-1', 'contact-2']);
  });

  it('returns an empty array when there are no contact associations', () => {
    const out = mapEngagement('notes', rec({ hs_note_body: 'x' }));
    expect(out.associatedContactHubspotIds).toEqual([]);
  });

  it('returns a null date when hs_timestamp is missing or unparseable', () => {
    expect(mapEngagement('notes', rec({ hs_note_body: 'x' })).date).toBeNull();
    expect(mapEngagement('notes', rec({ hs_note_body: 'x', hs_timestamp: 'not-a-number' })).date).toBeNull();
  });

  it('returns a null date rather than throwing for a numeric string outside Date range', () => {
    expect(mapEngagement('notes', rec({ hs_note_body: 'x', hs_timestamp: '1e21' })).date).toBeNull();
  });
});

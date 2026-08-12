import { describe, it, expect } from 'vitest';
import { mapEngagement } from '../src/services/hubspot/engagementMappers.js';

describe('mapEngagement — HTML body stripping', () => {
  it('strips HubSpot rich-text markup from a note body down to plain text', () => {
    const m = mapEngagement('notes', {
      id: 'note-1',
      properties: {
        hs_note_body: '<div style="" dir="auto" data-top-level="true"><p style="margin:0;">hii testing</p></div>',
        hs_timestamp: '1700000000000',
      },
    });
    expect(m.description).toBe('hii testing');
  });

  it('strips markup + nested spans from a meeting body', () => {
    const m = mapEngagement('meetings', {
      id: 'meeting-1',
      properties: {
        hs_meeting_body:
          '<div style="" dir="auto" data-top-level="true"><p style="margin:0;"><span style="color: rgb(140, 140, 140);"><span style="font-size: 11.7px;">Some notes</span></span></p></div>',
        hs_meeting_title: 'Kickoff',
        hs_timestamp: '1700000000000',
      },
    });
    expect(m.description).toBe('Some notes');
  });

  it('leaves plain text bodies (no markup) unchanged', () => {
    const m = mapEngagement('tasks', {
      id: 'task-1',
      properties: { hs_task_subject: 'Send NDA', hs_task_body: 'Standard mutual NDA', hs_timestamp: '1700000000000' },
    });
    expect(m.description).toBe('Standard mutual NDA');
  });

  it('returns null description for an empty/missing body rather than an empty string', () => {
    const m = mapEngagement('notes', { id: 'note-2', properties: { hs_note_body: null, hs_timestamp: '1700000000000' } });
    expect(m.description).toBeNull();
  });
});

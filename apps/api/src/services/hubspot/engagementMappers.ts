import sanitizeHtml from 'sanitize-html';
import { decodeHTML } from 'entities';
import type { EngagementType, HubSpotRecord, InteractionType, MappedEngagement } from './types.js';

const INTERACTION_TYPE: Record<EngagementType, InteractionType> = {
  notes: 'NOTE', calls: 'CALL', meetings: 'MEETING', emails: 'EMAIL', tasks: 'OTHER',
};

/** HubSpot returns date/datetime properties as epoch-millisecond strings. */
function fromEpochMs(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Number(value);
  // Date's valid range is roughly ±8.64e15ms (~year 275760) — a finite
  // number outside that range still passes Number.isFinite but throws
  // RangeError from .toISOString(). Guard explicitly rather than relying
  // on a downstream try/catch to paper over a string this function should
  // itself treat as "no usable timestamp."
  if (!Number.isFinite(ms) || Math.abs(ms) > 8_640_000_000_000_000) return null;
  return new Date(ms).toISOString();
}

/** hs_call_duration is milliseconds, e.g. "332000" -> "5m 32s". */
function formatDuration(msValue: string | null | undefined): string | null {
  if (!msValue) return null;
  const totalMs = Number(msValue);
  if (!Number.isFinite(totalMs)) return null;
  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * HubSpot's rich-text engagement bodies (hs_note_body, hs_call_body,
 * hs_meeting_body, hs_task_body) come back as HTML, not plain text — the
 * deal/contact activity feeds render this as plain text, so leaving the
 * markup in produces literal "<div>...</div>" on screen.
 *
 * sanitizeHtml only strips tags; it does NOT decode the HTML entities left
 * behind in the remaining text (a literal "<" typed inside the rich-text
 * editor round-trips as the source "&lt;"), so a second decodeHTML pass is
 * required or those entities render as literal "&lt;"/"&amp;" on screen.
 *
 * Do NOT run every body-ish property through this: hs_email_text is
 * HubSpot's plain-text extract (paired with a separate hs_email_html for
 * the rich-text version) — see mapEngagement's emails branch, which passes
 * it through untouched instead of calling this.
 */
function stripHtml(value: string | null | undefined): string | null {
  if (!value) return null;
  const stripped = sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
  const text = decodeHTML(stripped).trim();
  return text || null;
}

/**
 * hs_email_text is already HubSpot's plain-text extract of the email body
 * (its sibling hs_email_html carries the rich-text version) — running it
 * through stripHtml's tag stripper would silently eat any bare "<"/">" the
 * text legitimately contains, e.g. a quoted "Name <email@domain.com>"
 * header/signature line, which sanitize-html parses as an unrecognized tag
 * and discards along with its "content" (the email address itself).
 */
function plainText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  return text || null;
}

function joinParts(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? kept.join(' · ') : null;
}

export function mapEngagement(type: EngagementType, r: HubSpotRecord): MappedEngagement {
  const p = r.properties;
  const associatedContactHubspotIds = r.associations?.contacts?.results?.map((c) => c.id) ?? [];
  const associatedDealHubspotIds = r.associations?.deals?.results?.map((d) => d.id) ?? [];
  const base = { hubspotId: r.id, interactionType: INTERACTION_TYPE[type], associatedContactHubspotIds, associatedDealHubspotIds };

  if (type === 'notes') {
    return { ...base, title: null, description: stripHtml(p.hs_note_body), date: fromEpochMs(p.hs_timestamp) };
  }

  if (type === 'calls') {
    const duration = formatDuration(p.hs_call_duration);
    return {
      ...base,
      title: p.hs_call_title || null,
      description: joinParts([stripHtml(p.hs_call_body), duration ? `Duration: ${duration}` : null, p.hs_call_direction ? `Direction: ${p.hs_call_direction}` : null]),
      date: fromEpochMs(p.hs_timestamp),
    };
  }

  if (type === 'meetings') {
    return {
      ...base,
      title: p.hs_meeting_title || null,
      description: joinParts([stripHtml(p.hs_meeting_body), p.hs_meeting_outcome ? `Outcome: ${p.hs_meeting_outcome}` : null]),
      date: fromEpochMs(p.hs_meeting_start_time || p.hs_timestamp),
    };
  }

  if (type === 'emails') {
    return { ...base, title: p.hs_email_subject || null, description: plainText(p.hs_email_text), date: fromEpochMs(p.hs_timestamp) };
  }

  // tasks
  return {
    ...base,
    title: `[Task] ${p.hs_task_subject?.trim() || 'Untitled Task'}`,
    description: joinParts([stripHtml(p.hs_task_body), p.hs_task_status ? `Status: ${p.hs_task_status}` : null, p.hs_task_priority ? `Priority: ${p.hs_task_priority}` : null]),
    date: fromEpochMs(p.hs_timestamp),
  };
}

// ─── Clay inbound sourcing import — thin Clay-specific wrapper ───────
//
// Clay has no query/search API to call outward — confirmed in
// services/outreachEnrichment.ts's module header (no synchronous "search
// companies by filter" endpoint on a normal plan). Sourcing here works the
// other way round from that file's enrichment integration: a human filters
// a company list inside Clay's own UI (industry, location, employee size),
// then Clay pushes the resulting rows OUT to us via an outbound HTTP
// webhook action a human configures inside Clay's table
// (routes/outreach-clay-import-webhook.ts receives it).
//
// The actual de-dupe/match/create/update logic (CIN → email → normalized
// company name, never-silently-merge) lives in services/outreachContactImport.ts
// — a provider-agnostic engine shared with the Private Circle CSV import
// path (services/outreachPrivateCircleImport.ts). This module is now just:
//   1. normalizeClayPayloadToRows() — Clay-specific payload-shape sniffing
//      (Clay has no fixed schema for its outbound webhook, unlike Private
//      Circle's fixed CSV column export).
//   2. processClayImportBatch() — calls the shared engine with
//      sourceProvider: 'clay', touchChannel: 'clay_import', then narrows
//      the result back down to the documented
//      {received, created, updated, flaggedForReview} response shape so
//      routes/outreach-clay-import-webhook.ts (and Clay's delivery log)
//      keep seeing exactly the same contract as before this refactor.
//
// ─── Expected payload shape (OUR contract, not a confirmed Clay field
//     dictionary — Clay has no fixed schema for this direction) ─────────
//
// This module does not know Clay's actual outbound column names, because
// they're whatever the human names the columns in their Clay table. What
// it expects is documented here as the target shape; the human configuring
// Clay's "Send Webhook" action must map their table's columns to these
// keys (Clay's webhook action lets you name each JSON field it sends —
// point each one at the matching key below):
//
//   {
//     "companyName": "Acme Technologies Pvt Ltd",   // required
//     "contactName": "Priya Sharma",                 // decision-maker, if identified
//     "email": "priya@acme.com",
//     "phone": "+91 98765 43210",
//     "title": "VP Operations",
//     "linkedinUrl": "https://linkedin.com/in/...",
//     "location": "Mumbai, India",
//     "employeeSize": "51-200",
//     "industry": "Manufacturing",
//     "sourceUrl": "https://...",                    // Clay row / source link
//     "cin": "U72200MH2015PTC262812"                 // optional, most reliable de-dupe key
//   }
//
// The webhook route accepts this shape three ways, since Clay's "Send
// Webhook" action can be configured to fire per-row or batched:
//   - a bare array of the objects above
//   - { "rows": [ ...objects... ] }  (or "data"/"records", same idea)
//   - a single un-wrapped object (one row per webhook call)
// See normalizeClayPayloadToRows() below.
//
// See services/outreachContactImport.ts for the full de-duplication
// priority order (CIN → email → normalized company name → flag for human
// review) — identical for every import source, Clay included.

import { log } from '../utils/logger.js';
import { processContactImportBatch, type ContactImportSummary } from './outreachContactImport.js';

/** @deprecated import ContactImportRow from outreachContactImport.ts instead. Kept as an alias for any external readers. */
export type { ContactImportRow as ClayImportRow } from './outreachContactImport.js';

export type ClayImportSummary = ContactImportSummary;

const CLAY_SOURCE_PROVIDER = 'clay';
const CLAY_TOUCH_CHANNEL = 'clay_import';

/**
 * Normalizes whatever shape Clay's webhook action actually sends into a
 * flat array of unvalidated row objects — see the module header for the
 * three accepted shapes. Returns [] for anything unrecognized; callers
 * treat that as "nothing to import", not an error.
 */
export function normalizeClayPayloadToRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.records)) return obj.records;
    // A single un-wrapped row — Clay's webhook action can be configured to
    // fire once per row instead of batching.
    if ('companyName' in obj) return [obj];
  }

  return [];
}

/**
 * Processes one Clay webhook delivery's worth of rows against the given
 * org, via the shared contact-import engine. Never throws — see
 * outreachContactImport.ts's processContactImportBatch for the per-row
 * failure handling.
 */
export async function processClayImportBatch(orgId: string, rawRows: unknown[]): Promise<ClayImportSummary> {
  const result = await processContactImportBatch(orgId, rawRows, {
    sourceProvider: CLAY_SOURCE_PROVIDER,
    touchChannel: CLAY_TOUCH_CHANNEL,
  });

  log.info('outreachClayImport: batch delegated to shared contact-import engine', {
    received: result.received,
    created: result.created,
    updated: result.updated,
    flaggedForReview: result.flaggedForReview,
  });

  // Narrow back down to the documented response shape — the shared engine's
  // result also carries createdContactIdsMissingEmail (for Private Circle's
  // auto-enrichment trigger), which Clay's webhook route never asked for
  // and shouldn't start returning.
  return {
    received: result.received,
    created: result.created,
    updated: result.updated,
    flaggedForReview: result.flaggedForReview,
  };
}

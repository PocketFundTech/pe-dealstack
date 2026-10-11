import type { HubSpotRecord, HubSpotObjectType, HubSpotOwner, HubSpotFileMeta } from './types.js';
import { log } from '../../utils/logger.js';

const BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 5;

/**
 * Upper bound on a single 429 backoff sleep. Retry-After is controlled by an
 * external server, and this code runs inside a Vercel function that is
 * hard-killed at 300s (vercel.json maxDuration) — an uncapped wait (a huge
 * Retry-After, or a value denominated in ms rather than seconds) would sleep
 * straight past the function deadline and kill the request mid-import.
 * HubSpot's burst limit is per 10-second rolling window, so a real 429
 * clears within ~10s anyway.
 */
const MAX_BACKOFF_MS = 10_000;

export const MAX_PROPERTIES = 250;

/**
 * Standard HubSpot properties we always request, on top of the client's custom
 * ones. HubSpot only returns properties you ask for by name, so anything absent
 * here is silently missing from the import — keep this list generous.
 */
export const STANDARD_PROPERTIES: Record<HubSpotObjectType, string[]> = {
  companies: [
    'name', 'industry', 'domain', 'website', 'description', 'phone',
    'address', 'city', 'state', 'zip', 'country',
    'numberofemployees', 'annualrevenue', 'type', 'lifecyclestage',
    'linkedin_company_page', 'founded_year',
  ],
  contacts: [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle',
    'company', 'associatedcompanyid', 'website',
    'address', 'city', 'state', 'zip', 'country',
    'lifecyclestage', 'hs_lead_status',
  ],
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline', 'description',
    'closedate', 'createdate', 'dealtype', 'hs_deal_stage_probability', 'hubspot_owner_id',
  ],
  notes: ['hs_note_body', 'hs_timestamp', 'hs_attachment_ids'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_timestamp', 'hs_call_duration', 'hs_call_direction', 'hs_attachment_ids'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_timestamp', 'hs_attachment_ids'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_timestamp', 'hs_email_direction', 'hs_attachment_ids'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_timestamp', 'hs_task_status', 'hs_task_priority', 'hs_attachment_ids'],
};

/** Object types whose company association we resolve via the associations API. */
const COMPANY_ASSOCIATED: HubSpotObjectType[] = ['deals', 'contacts'];
/** Engagement types whose contact association we resolve via the associations API. */
const CONTACT_ASSOCIATED: HubSpotObjectType[] = ['notes', 'calls', 'meetings', 'emails', 'tasks'];

export interface ListPage {
  results: HubSpotRecord[];
  nextCursor: string | null;
}

export interface TokenValidation {
  ok: boolean;
  status: number;
  category: string | null; // HubSpot error category, e.g. MISSING_SCOPES / INVALID_AUTHENTICATION
}

/**
 * HubSpot refused a call for lack of a scope (401/403). Optional parts of the
 * import (owners, files) catch this and skip themselves with a note naming
 * `scopes`, instead of failing the import.
 */
export class HubSpotScopeError extends Error {
  readonly name = 'HubSpotScopeError';
  constructor(readonly scopes: string, readonly status: number) {
    super(`HubSpot ${status}: missing scope(s) ${scopes}`);
  }
}

const OWNER_SCOPES = 'crm.objects.owners.read';
const FILE_SCOPES = 'files, files.ui_hidden.read';

export class HubSpotClient {
  constructor(private token: string) {}

  private async requestWithBackoff(url: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        // Network blip (reset / DNS / timeout). Used to end the whole object
        // type mid-import, silently dropping every record after this page.
        if (attempt === MAX_RETRIES) throw err;
        const waitMs = Math.min(MAX_BACKOFF_MS, 2 ** attempt * 500);
        log.warn(`[hubspot] network error, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // HubSpot 5xx are transient; retry them like a 429 (no Retry-After).
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = Math.min(MAX_BACKOFF_MS, 2 ** attempt * 500);
        log.warn(`[hubspot] ${res.status} from HubSpot, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (res.status !== 429) return res as unknown as Response;
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
      const waitMs = Math.min(MAX_BACKOFF_MS, Math.max(0, retryAfter) * 1000 || 2 ** attempt * 250);
      log.warn(`[hubspot] 429 rate-limited, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    throw new Error('HubSpot rate limit: exceeded max retries');
  }

  async validateToken(): Promise<TokenValidation> {
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/objects/companies?limit=1`);
    if (res.ok) return { ok: true, status: res.status, category: null };
    let category: string | null = null;
    try {
      const body = (await res.json()) as { category?: string };
      category = body.category ?? null;
    } catch {
      // HubSpot error bodies are JSON, but don't fail validation reporting if not
    }
    return { ok: false, status: res.status, category };
  }

  async listPropertyNames(object: HubSpotObjectType): Promise<string[]> {
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/properties/${object}`);
    if (!res.ok) {
      log.warn(`[hubspot] property discovery failed for ${object}: ${res.status}`);
      return [...STANDARD_PROPERTIES[object]];
    }
    const data = (await res.json()) as { results?: Array<{ name: string; hubspotDefined?: boolean }> };
    const std = new Set(STANDARD_PROPERTIES[object]);
    // HubSpot sets hubspotDefined:true on its built-ins and OMITS the key on
    // user-created custom properties — it is optional in HubSpot's own schema.
    // Testing `=== false` therefore drops every custom field the client added.
    const kept = (data.results ?? []).filter((p) => p.hubspotDefined !== true || std.has(p.name)).map((p) => p.name);
    for (const s of STANDARD_PROPERTIES[object]) if (!kept.includes(s)) kept.push(s);
    if (kept.length > MAX_PROPERTIES) {
      // Standard fields first: they carry name/email/amount, so dropping them
      // to make room for custom fields imports every record blank.
      const standard = kept.filter((n) => std.has(n));
      const custom = kept.filter((n) => !std.has(n));
      const ordered = [...standard, ...custom];
      const capped = ordered.slice(0, MAX_PROPERTIES);
      const dropped = ordered.slice(MAX_PROPERTIES);
      log.warn(`[hubspot] ${object} has ${kept.length} kept properties; capping at ${MAX_PROPERTIES}. Dropped: ${dropped.join(', ')}`);
      return capped;
    }
    return kept;
  }

  /**
   * Map HubSpot's internal deal-stage ids → their human labels.
   * Custom pipelines use opaque numeric ids (e.g. "104512345"), so without this
   * the stage is stored as a meaningless number. Non-fatal: an empty map just
   * means stages stay unmapped.
   */
  async listDealStageLabels(): Promise<Record<string, string>> {
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/pipelines/deals`);
    if (!res.ok) {
      log.warn(`[hubspot] deal pipeline lookup failed: ${res.status} — stages will stay unmapped`);
      return {};
    }
    const data = (await res.json()) as { results?: Array<{ stages?: Array<{ id: string; label: string }> }> };
    const out: Record<string, string> = {};
    for (const pipeline of data.results ?? []) {
      for (const stage of pipeline.stages ?? []) out[stage.id] = stage.label;
    }
    return out;
  }

  /**
   * How many records of `object` the portal has, for "X of Y" progress.
   * The search API returns `total` even with limit 1. Null on any failure —
   * progress then shows counts without a total; the import itself is
   * unaffected.
   */
  async countObjects(object: HubSpotObjectType): Promise<number | null> {
    // The search API allows only a few calls per second; retry a 429 after a
    // short wait instead of reporting "size unknown".
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${BASE}/crm/v3/objects/${object}/search`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 1, properties: ['hs_object_id'] }),
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1100 * (attempt + 1)));
          continue;
        }
        if (!res.ok) return null;
        const data = (await res.json()) as { total?: number };
        return typeof data.total === 'number' ? data.total : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async listPage(
    object: HubSpotObjectType,
    opts: { limit?: number; after?: string; properties?: string[] },
  ): Promise<ListPage> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    const props = opts.properties && opts.properties.length ? opts.properties : STANDARD_PROPERTIES[object];
    params.set('properties', props.join(','));
    // Deals also need their contacts (deal↔contact links). Contacts only need
    // their company.
    if (object === 'deals') params.set('associations', 'companies,contacts');
    else if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');
    // Also fetch deal associations: engagements with no resolvable contact
    // fall back to the deal's activity feed rather than being dropped.
    if (CONTACT_ASSOCIATED.includes(object)) params.set('associations', 'contacts,deals');
    if (opts.after) params.set('after', opts.after);
    const res = await this.requestWithBackoff(`${BASE}/crm/v3/objects/${object}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HubSpot ${object} list failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { results?: HubSpotRecord[]; paging?: { next?: { after?: string } } };
    return {
      results: data.results ?? [],
      nextCursor: data.paging?.next?.after ?? null,
    };
  }

  /** Every owner (HubSpot user) in the portal. */
  async listOwners(): Promise<HubSpotOwner[]> {
    const out: HubSpotOwner[] = [];
    let after: string | null = null;
    do {
      const params = new URLSearchParams({ limit: '100' });
      if (after) params.set('after', after);
      const res = await this.requestWithBackoff(`${BASE}/crm/v3/owners?${params.toString()}`);
      if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(OWNER_SCOPES, res.status);
      if (!res.ok) throw new Error(`HubSpot owners list failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as {
        results?: Array<{ id: string; email?: string | null; firstName?: string | null; lastName?: string | null }>;
        paging?: { next?: { after?: string } };
      };
      for (const o of data.results ?? []) {
        const name = [o.firstName, o.lastName].filter((p) => p && p.trim()).join(' ').trim();
        out.push({ id: String(o.id), email: o.email || null, name: name || null });
      }
      after = data.paging?.next?.after ?? null;
    } while (after);
    return out;
  }

  /** File metadata, or null when HubSpot no longer has the file. */
  async getFileMeta(fileId: string): Promise<HubSpotFileMeta | null> {
    const res = await this.requestWithBackoff(`${BASE}/files/v3/files/${encodeURIComponent(fileId)}`);
    if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(FILE_SCOPES, res.status);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HubSpot file ${fileId} lookup failed: ${res.status}`);
    const f = (await res.json()) as { id: string; name?: string; extension?: string | null; size?: number | null };
    return { id: String(f.id), name: f.name || `hubspot-file-${fileId}`, extension: f.extension || null, size: f.size ?? null };
  }

  /** A short-lived download URL for a file (CRM attachments are "hidden" files). */
  async getFileSignedUrl(fileId: string): Promise<string> {
    const res = await this.requestWithBackoff(`${BASE}/files/v3/files/${encodeURIComponent(fileId)}/signed-url`);
    if (res.status === 401 || res.status === 403) throw new HubSpotScopeError(FILE_SCOPES, res.status);
    if (!res.ok) throw new Error(`HubSpot signed URL for ${fileId} failed: ${res.status}`);
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error(`HubSpot returned no signed URL for ${fileId}`);
    return data.url;
  }

  /** Download a signed URL. No Authorization header: the URL itself is the credential. */
  async downloadSignedUrl(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

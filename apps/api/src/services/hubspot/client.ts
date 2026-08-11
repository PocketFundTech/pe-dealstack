import type { HubSpotRecord, HubSpotObjectType } from './types.js';
import { log } from '../../utils/logger.js';

const BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 5;

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
    'closedate', 'createdate', 'dealtype', 'hs_deal_stage_probability',
  ],
};

/** Object types whose company association we resolve via the associations API. */
const COMPANY_ASSOCIATED: HubSpotObjectType[] = ['deals', 'contacts'];

export interface ListPage {
  results: HubSpotRecord[];
  nextCursor: string | null;
}

export interface TokenValidation {
  ok: boolean;
  status: number;
  category: string | null; // HubSpot error category, e.g. MISSING_SCOPES / INVALID_AUTHENTICATION
}

export class HubSpotClient {
  constructor(private token: string) {}

  private async requestWithBackoff(url: string): Promise<Response> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      });
      if (res.status !== 429) return res as unknown as Response;
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
      const waitMs = Math.max(0, retryAfter) * 1000 || 2 ** attempt * 250;
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

  async listPage(
    object: HubSpotObjectType,
    opts: { limit?: number; after?: string; properties?: string[] },
  ): Promise<ListPage> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    const props = opts.properties && opts.properties.length ? opts.properties : STANDARD_PROPERTIES[object];
    params.set('properties', props.join(','));
    if (COMPANY_ASSOCIATED.includes(object)) params.set('associations', 'companies');
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
}

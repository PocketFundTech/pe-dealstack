import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { HubSpotClient } from './client.js';
import { mapCompany, mapContact, mapDeal } from './mappers.js';
import { mapEngagement } from './engagementMappers.js';
import { upsertByHubspotId, upsertContactInteractionByHubspotId, type ImportMode } from './dedup.js';
import type { EngagementType, HubSpotObjectType } from './types.js';

const ORDER: HubSpotObjectType[] = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks'];
const ENGAGEMENT_TYPES: EngagementType[] = ['notes', 'calls', 'meetings', 'emails', 'tasks'];
const BATCH = 100;

/**
 * Deal pipeline stage labels are invariant for the whole import job, but
 * runImportBatch is called once per ~100-record batch (up to MAX_BATCHES
 * times). Cache per jobId so we fetch /crm/v3/pipelines/deals once instead of
 * once per batch. Entries are removed when the job leaves the 'deals' stage.
 */
const stageLabelCache = new Map<string, Record<string, string>>();

/** Test-only: clear the cache between test cases. */
export function resetStageLabelCache(): void {
  stageLabelCache.clear();
}

interface Counters { processed: number; created: number; updated: number; failed: number; }
const emptyCounters = (): Counters => ({ processed: 0, created: 0, updated: 0, failed: 0 });

async function loadJob(jobId: string) {
  const { data } = await supabase.from('ImportJob').select('*').eq('id', jobId).maybeSingle();
  return data as null | {
    id: string; organizationId: string; status: string;
    objectCounts: Record<string, Counters>; currentObject: string | null; cursor: string | null;
  };
}

async function saveJob(jobId: string, patch: Record<string, unknown>) {
  await supabase.from('ImportJob').update(patch).eq('id', jobId);
}

/**
 * Resolve a HubSpot company id → the local Company name we imported for it.
 * Contacts/Deals reference companies by HubSpot id; we store the name as free text.
 */
async function companyNameForHubspotId(orgId: string, hubspotCompanyId: string | null): Promise<string | null> {
  if (!hubspotCompanyId) return null;
  const { data } = await supabase
    .from('Company').select('name')
    .eq('organizationId', orgId).eq('hubspotId', hubspotCompanyId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/**
 * Resolve a HubSpot contact id → the local Contact's id. Engagements
 * reference contacts by HubSpot id via the associations API.
 */
async function contactIdForHubspotId(orgId: string, hubspotContactId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Contact').select('id')
    .eq('organizationId', orgId).eq('hubspotId', hubspotContactId).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * Process ONE batch for the job's current object. Returns true if more work remains.
 * @param mode 'fill' never overwrites existing local values; 'refresh' lets
 *   HubSpot win for the fields it maps, so corrections propagate on re-import.
 */
export async function runImportBatch(jobId: string, token: string, mode: ImportMode = 'fill'): Promise<boolean> {
  const more = await runImportBatchInner(jobId, token, mode);
  // `false` means the job is done (completed/failed/cancelled) — no further
  // batches will use this jobId's cached stage labels.
  if (!more) stageLabelCache.delete(jobId);
  return more;
}

async function runImportBatchInner(jobId: string, token: string, mode: ImportMode): Promise<boolean> {
  const job = await loadJob(jobId);
  if (!job) return false;
  if (job.status === 'cancelled') return false;

  const client = new HubSpotClient(token);
  const counts = { ...job.objectCounts };
  ORDER.forEach((o) => { if (!counts[o]) counts[o] = emptyCounters(); });

  // Deals in a batch commonly share a company — a portfolio CRM has far
  // fewer companies than deals. Cache both lookups per batch so a shared
  // company costs one round-trip instead of one per deal.
  const companyNameCache = new Map<string, string | null>();
  const companyIdCache = new Map<string, string | null>();
  async function companyNameForHubspotIdCached(orgId: string, hubspotCompanyId: string | null) {
    if (!hubspotCompanyId) return null;
    if (companyNameCache.has(hubspotCompanyId)) return companyNameCache.get(hubspotCompanyId) ?? null;
    const name = await companyNameForHubspotId(orgId, hubspotCompanyId);
    companyNameCache.set(hubspotCompanyId, name);
    return name;
  }
  async function resolveCompanyIdCached(orgId: string, name: string | null) {
    const key = (name ?? 'Unknown Company').toLowerCase();
    if (companyIdCache.has(key)) return companyIdCache.get(key) ?? null;
    const id = await resolveCompanyId(orgId, name);
    companyIdCache.set(key, id);
    return id;
  }

  const contactIdCache = new Map<string, string | null>();
  async function contactIdForHubspotIdCached(orgId: string, hubspotContactId: string) {
    if (contactIdCache.has(hubspotContactId)) return contactIdCache.get(hubspotContactId) ?? null;
    const id = await contactIdForHubspotId(orgId, hubspotContactId);
    contactIdCache.set(hubspotContactId, id);
    return id;
  }

  // Pick the current object (first not-yet-finished in ORDER).
  const current = (job.currentObject as HubSpotObjectType) ?? ORDER[0];
  const objectIndex = ORDER.indexOf(current);

  let page;
  let stageLabels: Record<string, string> = {};
  try {
    const properties = await client.listPropertyNames(current);
    // Deal stages come back as internal ids (opaque numbers on custom
    // pipelines); resolve them to labels so the stage is meaningful.
    // Cached per job — this result is the same for every batch of 'deals'.
    if (current === 'deals') {
      const cached = stageLabelCache.get(jobId);
      stageLabels = cached ?? await client.listDealStageLabels();
      if (!cached) stageLabelCache.set(jobId, stageLabels);
    }
    page = await client.listPage(current, { limit: BATCH, after: job.cursor ?? undefined, properties });
  } catch (err) {
    log.error(`[hubspot] batch fetch failed for ${current}: ${(err as Error).message}`);
    await saveJob(jobId, { status: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() });
    return false;
  }

  for (const rec of page.results) {
    try {
      if (current === 'companies') {
        const m = mapCompany(rec);
        const res = await upsertByHubspotId('Company', job.organizationId, m.hubspotId, {
          name: m.name, industry: m.industry, website: m.website,
          description: m.description, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name }, mode);
        counts.companies[res] += 1;
      } else if (current === 'contacts') {
        // Prefer the associations API; `associatedcompanyid` is a legacy
        // property that is frequently empty even when an association exists.
        const associatedCompanyId = rec.associations?.companies?.results?.[0]?.id
          ?? rec.properties.associatedcompanyid
          ?? null;
        const companyName = await companyNameForHubspotIdCached(job.organizationId, associatedCompanyId);
        const m = mapContact(rec, companyName);
        const res = await upsertByHubspotId('Contact', job.organizationId, m.hubspotId, {
          firstName: m.firstName, lastName: m.lastName, email: m.email, phone: m.phone,
          title: m.title, company: m.company, hubspotProperties: m.hubspotProperties,
        }, { column: 'email', value: m.email }, mode);
        counts.contacts[res] += 1;
      } else if (current === 'deals') {
        const m = mapDeal(rec, stageLabels[rec.properties.dealstage ?? ''] ?? null);
        const companyName = await companyNameForHubspotIdCached(job.organizationId, m.associatedCompanyHubspotId);
        // Deal requires a companyId — resolve or create the Company row.
        const companyId = await resolveCompanyIdCached(job.organizationId, companyName);
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          // Omit when unmapped: Deal.stage is NOT NULL and a null would either
          // fail the write or reset the deal to the INITIAL_REVIEW default.
          ...(m.stage ? { stage: m.stage } : {}),
          customFields: m.customFields, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name }, mode);
        counts.deals[res] += 1;
      } else {
        // One of the 5 engagement types (notes/calls/meetings/emails/tasks).
        const m = mapEngagement(current as EngagementType, rec);
        const resolvedContactIds = (await Promise.all(
          m.associatedContactHubspotIds.map((hsId) => contactIdForHubspotIdCached(job.organizationId, hsId)),
        )).filter((id): id is string => id !== null);

        if (resolvedContactIds.length > 0) {
          // Fan out: one HubSpot engagement can be associated with several
          // local contacts (e.g. a multi-person meeting) — write one row each.
          let anyCreated = false;
          for (const contactId of resolvedContactIds) {
            const res = await upsertContactInteractionByHubspotId(contactId, m.hubspotId, {
              type: m.interactionType, title: m.title, description: m.description,
              date: m.date ?? new Date().toISOString(),
            }, mode);
            if (res === 'created') anyCreated = true;
          }
          counts[current][anyCreated ? 'created' : 'updated'] += 1;
        }
        // No resolvable local contact: this phase is contact-scoped only
        // (per spec) — skip silently. `processed` still increments below;
        // this record contributes to neither created/updated/failed.
      }
    } catch (err) {
      counts[current].failed += 1;
      log.warn(`[hubspot] record ${rec.id} (${current}) failed: ${(err as Error).message}`);
    }
    counts[current].processed += 1;
  }

  // Advance cursor or move to the next object.
  // Use a cancel-guarded update: .neq('status', 'cancelled') ensures a concurrent
  // cancel cannot be clobbered. If updated is null, the job was cancelled — stop.
  if (page.nextCursor) {
    const { data: updated } = await supabase.from('ImportJob')
      .update({ objectCounts: counts, currentObject: current, cursor: page.nextCursor, status: 'running' })
      .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
    if (!updated) return false; // cancelled mid-batch
    return true;
  }
  const nextObject = ORDER[objectIndex + 1] ?? null;
  if (nextObject) {
    const { data: updated } = await supabase.from('ImportJob')
      .update({ objectCounts: counts, currentObject: nextObject, cursor: null, status: 'running' })
      .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
    if (!updated) return false; // cancelled mid-batch
    return true;
  }
  const { data: updated } = await supabase.from('ImportJob')
    .update({ objectCounts: counts, currentObject: null, cursor: null, status: 'completed', finishedAt: new Date().toISOString() })
    .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
  // If updated is null the job was cancelled — status already 'cancelled', return false.
  void updated;
  return false;
}

/** Find the local Company by name (case-insensitive); create a stub if absent. */
async function resolveCompanyId(orgId: string, name: string | null): Promise<string | null> {
  const target = name ?? 'Unknown Company';
  // .limit(1) not .maybeSingle(): two companies may legitimately share a name,
  // and PGRST116 would fail the whole deal record. .order() makes which
  // duplicate gets adopted deterministic instead of Postgres's unspecified order.
  const { data: found } = await supabase
    .from('Company').select('id').eq('organizationId', orgId).ilike('name', target)
    .order('createdAt', { ascending: true }).limit(1);
  const hit = (found as Array<{ id: string }> | null)?.[0];
  if (hit) return hit.id;
  const { data: created } = await supabase
    .from('Company').insert({ name: target, organizationId: orgId }).select('id').maybeSingle();
  return (created as { id?: string } | null)?.id ?? null;
}

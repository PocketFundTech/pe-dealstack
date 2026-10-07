import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { HubSpotClient } from './client.js';
import { mapCompany, mapContact, mapDeal } from './mappers.js';
import { mapEngagement } from './engagementMappers.js';
import { upsertByHubspotId, upsertContactInteractionByHubspotId, upsertDealActivityByHubspotId, type ImportMode, type RecordUpsertResult } from './dedup.js';
import { escapeIlike } from './ilike.js';
import { loadLiveDealIndex, normaliseCompanyName, type DealMatch } from '../dealDuplicates.js';
import type { EngagementType, HubSpotObjectType } from './types.js';

const ORDER: HubSpotObjectType[] = ['companies', 'contacts', 'deals', 'notes', 'calls', 'meetings', 'emails', 'tasks'];
const ENGAGEMENT_TYPES: EngagementType[] = ['notes', 'calls', 'meetings', 'emails', 'tasks'];
const BATCH = 100;

/**
 * Activity.type + a fallback title per engagement type, used when an
 * engagement has no resolvable contact and falls back to the deal's
 * activity feed. Mirrors the type strings the deal-chat add_note tool
 * already writes (apps/api/src/services/agents/dealChatAgent/tools/addNote.ts)
 * so the deal activity feed renders a matching icon.
 */
const DEAL_ACTIVITY_META: Record<EngagementType, { type: string; fallbackTitle: string }> = {
  notes: { type: 'NOTE_ADDED', fallbackTitle: 'Note' },
  calls: { type: 'CALL_LOGGED', fallbackTitle: 'Call Logged' },
  meetings: { type: 'MEETING_SCHEDULED', fallbackTitle: 'Meeting' },
  emails: { type: 'EMAIL_SENT', fallbackTitle: 'Email' },
  tasks: { type: 'TASK_ADDED', fallbackTitle: 'Task' },
};

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

interface Counters {
  processed: number; created: number; updated: number; failed: number; skipped: number;
  /** Records HubSpot says this object has (for "X of Y" progress); null if unknown. */
  total?: number | null;
  /**
   * Of `updated`, how many were existing Avise rows that no HubSpot record
   * owned yet and were linked rather than duplicated (for deals: the deal a
   * CIM upload already created). Absent on jobs stored before this existed.
   */
  matched?: number;
}
const emptyCounters = (): Counters => ({ processed: 0, created: 0, updated: 0, failed: 0, skipped: 0 });

/** Count an upsert outcome; a `linked` row is an update that is also `matched`. */
function tally(c: Counters, res: RecordUpsertResult): void {
  if (res === 'linked') {
    c.updated += 1;
    c.matched = (c.matched ?? 0) + 1;
  } else {
    c[res] += 1;
  }
}

/** Company names that are placeholders, not identities — never match a deal on them. */
function dealMatchKey(companyName: string | null): string | null {
  if (!companyName || companyName.trim().toLowerCase() === 'unknown company') return null;
  const key = normaliseCompanyName(companyName);
  return key.length >= 3 ? key : null;
}

async function loadJob(jobId: string) {
  const { data } = await supabase.from('ImportJob').select('*').eq('id', jobId).maybeSingle();
  return data as null | {
    id: string; organizationId: string; status: string;
    objectCounts: Record<string, Counters>; currentObject: string | null; cursor: string | null;
    error?: string | null;
  };
}

async function saveJob(jobId: string, patch: Record<string, unknown>) {
  await supabase.from('ImportJob').update(patch).eq('id', jobId);
}

/**
 * Resolve a HubSpot company id → the local Company name we imported for it.
 * Contacts/Deals reference companies by HubSpot id; we store the name as free text.
 */
async function companyForHubspotId(orgId: string, hubspotCompanyId: string | null): Promise<{ id: string | null; name: string | null }> {
  if (!hubspotCompanyId) return { id: null, name: null };
  const { data } = await supabase
    .from('Company').select('id, name')
    .eq('organizationId', orgId).eq('hubspotId', hubspotCompanyId).maybeSingle();
  const row = data as { id?: string; name?: string } | null;
  return { id: row?.id ?? null, name: row?.name ?? null };
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
 * Resolve a HubSpot deal id → the local Deal's id. Used as the fallback
 * association for engagements with no resolvable contact.
 */
async function dealIdForHubspotId(orgId: string, hubspotDealId: string): Promise<string | null> {
  const { data } = await supabase
    .from('Deal').select('id')
    .eq('organizationId', orgId).eq('hubspotId', hubspotDealId).maybeSingle();
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
  const companyCache = new Map<string, { id: string | null; name: string | null }>();
  const companyIdCache = new Map<string, string | null>();
  async function companyForHubspotIdCached(orgId: string, hubspotCompanyId: string | null) {
    if (!hubspotCompanyId) return { id: null, name: null };
    const hit = companyCache.get(hubspotCompanyId);
    if (hit) return hit;
    const company = await companyForHubspotId(orgId, hubspotCompanyId);
    companyCache.set(hubspotCompanyId, company);
    return company;
  }
  async function companyNameForHubspotIdCached(orgId: string, hubspotCompanyId: string | null) {
    return (await companyForHubspotIdCached(orgId, hubspotCompanyId)).name;
  }
  async function resolveCompanyIdCached(orgId: string, name: string | null) {
    // A null name means "no resolvable HubSpot company for this deal" — every
    // such deal must get its own stub (see resolveCompanyId), so it must
    // never share a cache entry with another null-name deal.
    if (name === null) return resolveCompanyId(orgId, null);
    const key = name.toLowerCase();
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

  // Live deals no HubSpot deal owns yet, keyed by normalised company / deal
  // name — loaded once per batch on the first deal that needs it, so linking
  // a HubSpot deal to the deal a CIM upload already created costs no query
  // per record. A deal is removed once linked, so two HubSpot deals for the
  // same company never both claim it.
  let unlinkedDeals: Promise<Map<string, DealMatch>> | null = null;
  function unlinkedDealIndex(orgId: string) {
    unlinkedDeals ??= loadLiveDealIndex(orgId, { unlinkedOnly: true });
    return unlinkedDeals;
  }

  const dealIdCache = new Map<string, string | null>();
  async function dealIdForHubspotIdCached(orgId: string, hubspotDealId: string) {
    if (dealIdCache.has(hubspotDealId)) return dealIdCache.get(hubspotDealId) ?? null;
    const id = await dealIdForHubspotId(orgId, hubspotDealId);
    dealIdCache.set(hubspotDealId, id);
    return id;
  }

  // Totals for every object, fetched once per job (null = unknown, not
  // re-fetched), so the panel can show "X of Y" and an ETA from the start
  // instead of an open-ended counter (6 Oct testing: "users feel lost").
  const missingTotals = ORDER.filter((o) => counts[o].total === undefined);
  // One at a time: HubSpot's search API has its own low rate limit (a few
  // requests/second), and firing all eight at once 429'd some of them, so
  // companies and deals showed no total (7 Oct testing).
  for (const o of missingTotals) {
    let total: number | null = null;
    try { total = await client.countObjects(o); } catch { total = null; }
    counts[o] = { ...counts[o], total };
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
    // Say what was skipped. Before, a failure on a LATER page advanced to the
    // next object type silently: the job read "completed" with only the
    // first few hundred companies imported (6 Oct testing).
    const done = counts[current]?.processed ?? 0;
    const note = job.cursor
      ? `${current}: stopped after ${done} records (${shortError(err)}). Run the import again to pick up the rest — imported records won't be duplicated.`
      : `${current}: not imported (${shortError(err)}).`;
    const errorSoFar = job.error ? `${job.error} | ${note}` : note;
    // A fetch failure for ONE object type (e.g. a missing HubSpot scope for
    // engagement objects — some portals can't even grant those scopes) must
    // not discard records already imported for prior object types. Skip this
    // object type and advance to the next one, mirroring the same
    // cancel-guarded advance used below for a normally-drained page. Only
    // fail the whole job if there's no next object type left to try.
    const nextObject = ORDER[objectIndex + 1] ?? null;
    if (nextObject) {
      const { data: updated } = await supabase.from('ImportJob')
        .update({ objectCounts: counts, currentObject: nextObject, cursor: null, status: 'running', error: errorSoFar })
        .eq('id', jobId).neq('status', 'cancelled').select('id').maybeSingle();
      if (!updated) return false; // cancelled mid-batch
      return true;
    }
    // No more object types to try. If anything else in this job succeeded
    // (e.g. Companies/Contacts/Deals imported fine but every engagement
    // type 403'd on a missing scope), don't report the whole job as
    // failed — that hides a mostly-successful import behind one object
    // type's error. The error message is preserved either way.
    const anySucceeded = Object.values(counts).some((c) => c.created + c.updated > 0);
    await saveJob(jobId, {
      status: anySucceeded ? 'completed' : 'failed',
      currentObject: null, cursor: null,
      error: errorSoFar,
      finishedAt: new Date().toISOString(),
    });
    return false;
  }

  for (const rec of page.results) {
    try {
      if (current === 'companies') {
        const m = mapCompany(rec);
        // mapCompany falls back to the literal 'Unknown Company' when HubSpot's
        // own name property is blank — that string is not a real identity, so
        // it must never be used as a natural-key match. Doing so used to
        // collapse every blank-named company onto one shared row, each import
        // overwriting the previous one's hubspotId.
        const hasRealName = !!rec.properties.name?.trim();
        const res = await upsertByHubspotId('Company', job.organizationId, m.hubspotId, {
          name: m.name, industry: m.industry, website: m.website,
          description: m.description, hubspotProperties: m.hubspotProperties,
        }, hasRealName ? { column: 'name', value: m.name } : undefined, mode);
        tally(counts.companies, res);
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
        tally(counts.contacts, res);
      } else if (current === 'deals') {
        const m = mapDeal(rec, stageLabels[rec.properties.dealstage ?? ''] ?? null);
        const company = await companyForHubspotIdCached(job.organizationId, m.associatedCompanyHubspotId);
        const companyName = company.name;
        // Deal requires a companyId. Use the imported HubSpot company itself
        // when we have it — two HubSpot companies may share a name, and a
        // name lookup would wire this deal to whichever came first. Otherwise
        // resolve by name or create the Company row.
        const companyId = company.id ?? await resolveCompanyIdCached(job.organizationId, companyName);
        // The deal may already exist in Avise without a hubspotId — typically
        // created from a CIM upload for the same company. Link it instead of
        // creating a duplicate (exact normalised-name match only; no fuzzy
        // matching in an unattended import). upsertByHubspotId still checks
        // the hubspotId first and only adopts the row while it's unlinked.
        const matchKey = dealMatchKey(companyName);
        const candidate = matchKey ? (await unlinkedDealIndex(job.organizationId)).get(matchKey) ?? null : null;
        const res = await upsertByHubspotId('Deal', job.organizationId, m.hubspotId, {
          name: m.name, companyId, dealSize: m.dealSize, description: m.description,
          // Omit when unmapped: Deal.stage is NOT NULL and a null would either
          // fail the write or reset the deal to the INITIAL_REVIEW default.
          ...(m.stage ? { stage: m.stage } : {}),
          customFields: m.customFields, hubspotProperties: m.hubspotProperties,
        }, { column: 'name', value: m.name, adoptId: candidate?.id ?? null }, mode);
        tally(counts.deals, res);
        if (res === 'linked' && candidate) {
          // Drop every key pointing at the now-linked deal (its company AND
          // deal name are both indexed).
          const index = await unlinkedDealIndex(job.organizationId);
          for (const [k, v] of index) if (v.id === candidate.id) index.delete(k);
        }
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
        } else {
          // No resolvable contact: PE workflows routinely log activity at
          // the deal level with no single contact attached (diligence
          // notes, internal call recaps) — that isn't missing data, so fall
          // back to the deal(s) this engagement is associated with instead
          // of dropping it.
          const resolvedDealIds = (await Promise.all(
            m.associatedDealHubspotIds.map((hsId) => dealIdForHubspotIdCached(job.organizationId, hsId)),
          )).filter((id): id is string => id !== null);

          if (resolvedDealIds.length > 0) {
            const meta = DEAL_ACTIVITY_META[current as EngagementType];
            let anyCreated = false;
            for (const dealId of resolvedDealIds) {
              const res = await upsertDealActivityByHubspotId(dealId, m.hubspotId, {
                type: meta.type, title: m.title || meta.fallbackTitle, description: m.description,
                createdAt: m.date ?? new Date().toISOString(),
              }, mode);
              if (res === 'created') anyCreated = true;
            }
            counts[current][anyCreated ? 'created' : 'updated'] += 1;
          } else {
            // Neither a contact nor a deal resolves — genuinely nothing to
            // attach this engagement to locally. Tracked separately so the
            // job response can distinguish "nothing to import" from
            // "imported everything" instead of looking identical.
            counts[current].skipped += 1;
          }
        }
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

/** HubSpot error bodies are long JSON; keep the status line for the UI. */
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

/** Find the local Company by name (case-insensitive); create a stub if absent. */
async function resolveCompanyId(orgId: string, name: string | null): Promise<string | null> {
  if (name === null) {
    // No HubSpot company association for this deal — give it its own stub
    // rather than searching for (and silently merging into) a shared
    // 'Unknown Company' placeholder. That placeholder isn't a real identity:
    // reusing it used to wire unrelated deals to whichever one of them
    // happened to resolve last.
    const { data: created } = await supabase
      .from('Company').insert({ name: 'Unknown Company', organizationId: orgId }).select('id').maybeSingle();
    return (created as { id?: string } | null)?.id ?? null;
  }
  // .limit(1) not .maybeSingle(): two companies may legitimately share a name,
  // and PGRST116 would fail the whole deal record. .order() makes which
  // duplicate gets adopted deterministic instead of Postgres's unspecified order.
  const { data: found } = await supabase
    .from('Company').select('id').eq('organizationId', orgId).ilike('name', escapeIlike(name))
    .order('createdAt', { ascending: true }).limit(1);
  const hit = (found as Array<{ id: string }> | null)?.[0];
  if (hit) return hit.id;
  const { data: created } = await supabase
    .from('Company').insert({ name, organizationId: orgId }).select('id').maybeSingle();
  return (created as { id?: string } | null)?.id ?? null;
}

import { supabase } from '../../supabase.js';

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * How a re-import treats fields that already hold a value locally.
 * - `fill`    — only populate blanks (default; never touches existing data)
 * - `refresh` — HubSpot wins for the fields it maps, so corrections propagate
 */
export type ImportMode = 'fill' | 'refresh';

/** Returns a copy of `existing` merged with `incoming` according to `mode`. */
export function mergeForImport<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
  mode: ImportMode,
): T {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (isBlank(v)) continue;                          // a blank from HubSpot never erases local data
    if (mode === 'refresh' || isBlank(out[k])) {
      // Merge nested objects (e.g. Deal.customFields) key-by-key rather than
      // replacing wholesale — customFields also holds non-HubSpot data (AI
      // follow-up notes, CSV-import custom columns) that a refresh must not erase.
      out[k] = isPlainObject(out[k]) && isPlainObject(v) ? { ...out[k], ...v } : v;
    }
  }
  return out as T;
}

/** Returns a copy of `existing` with only its blank fields filled from `incoming`. */
export function mergeBlankOnly<T extends Record<string, unknown>>(existing: T, incoming: Partial<T>): T {
  return mergeForImport(existing, incoming, 'fill');
}

export type UpsertResult = 'created' | 'updated';

/**
 * Upsert a mapped row into `table`, scoped to org.
 * Match priority: hubspotId, then a natural key column (`matchColumn`).
 * `row` must include hubspotProperties; organizationId + hubspotId are applied here.
 */
export async function upsertByHubspotId(
  table: 'Company' | 'Contact' | 'Deal',
  orgId: string,
  hubspotId: string,
  row: Record<string, unknown>,
  match?: { column: string; value: string | null },
  mode: ImportMode = 'fill',
): Promise<UpsertResult> {
  // 1. Match by hubspotId first.
  let { data: existing } = await supabase
    .from(table).select('*')
    .eq('organizationId', orgId).eq('hubspotId', hubspotId).maybeSingle();

  // 2. Fall back to natural key (case-insensitive) when provided.
  //    .limit(1) rather than .maybeSingle(): duplicate names are legitimate and
  //    must not throw PGRST116 and fail the record. .order() makes which
  //    duplicate gets adopted deterministic instead of Postgres's unspecified
  //    default order.
  let adopted = false;
  if (!existing && match?.value) {
    const res = await supabase
      .from(table).select('*')
      .eq('organizationId', orgId).ilike(match.column, match.value)
      .order('createdAt', { ascending: true }).limit(1);
    existing = (res.data as Array<Record<string, unknown>> | null)?.[0] ?? null;
    adopted = !!existing;
  }

  if (existing) {
    // A record adopted by natural key was created by the user, not by a prior
    // import — never overwrite their data on first link, whatever the mode.
    const merged = mergeForImport(existing as Record<string, unknown>, row, adopted ? 'fill' : mode);
    merged.hubspotId = hubspotId;
    merged.hubspotProperties = row.hubspotProperties;
    const { error } = await supabase.from(table).update(merged).eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`HubSpot ${table} update failed: ${error.message}`);
    return 'updated';
  }

  const { error } = await supabase.from(table).insert({ ...row, organizationId: orgId, hubspotId });
  if (error) throw new Error(`HubSpot ${table} insert failed: ${error.message}`);
  return 'created';
}

/**
 * Upsert a HubSpot-imported ContactInteraction. Scoped by contactId, not
 * organizationId — ContactInteraction has no organizationId column of its
 * own (it's scoped transitively via Contact). No natural-key fallback:
 * unlike a Company name or Contact email, there's no meaningful fuzzy match
 * for an interaction — (contactId, hubspotId) IS the identity.
 */
export async function upsertContactInteractionByHubspotId(
  contactId: string,
  hubspotId: string,
  row: Record<string, unknown>,
  mode: ImportMode,
): Promise<UpsertResult> {
  const { data: existing } = await supabase
    .from('ContactInteraction').select('*')
    .eq('contactId', contactId).eq('hubspotId', hubspotId).maybeSingle();

  if (existing) {
    const merged = mergeForImport(existing as Record<string, unknown>, row, mode);
    merged.hubspotId = hubspotId;
    const { error } = await supabase.from('ContactInteraction').update(merged).eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`HubSpot ContactInteraction update failed: ${error.message}`);
    return 'updated';
  }

  const { error } = await supabase.from('ContactInteraction').insert({ ...row, contactId, hubspotId });
  if (error) throw new Error(`HubSpot ContactInteraction insert failed: ${error.message}`);
  return 'created';
}

/**
 * Upsert a HubSpot-imported Activity row for an engagement that has no
 * resolvable contact but does have a resolvable deal. Scoped by dealId, not
 * organizationId — same reasoning as upsertContactInteractionByHubspotId:
 * (dealId, hubspotId) is the identity, no natural-key fallback applies.
 */
export async function upsertDealActivityByHubspotId(
  dealId: string,
  hubspotId: string,
  row: Record<string, unknown>,
  mode: ImportMode,
): Promise<UpsertResult> {
  const { data: existing } = await supabase
    .from('Activity').select('*')
    .eq('dealId', dealId).eq('hubspotId', hubspotId).maybeSingle();

  if (existing) {
    const merged = mergeForImport(existing as Record<string, unknown>, row, mode);
    merged.hubspotId = hubspotId;
    const { error } = await supabase.from('Activity').update(merged).eq('id', (existing as { id: string }).id);
    if (error) throw new Error(`HubSpot Activity update failed: ${error.message}`);
    return 'updated';
  }

  const { error } = await supabase.from('Activity').insert({ ...row, dealId, hubspotId });
  if (error) throw new Error(`HubSpot Activity insert failed: ${error.message}`);
  return 'created';
}

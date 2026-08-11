// ─── Firm Teaser Service ─────────────────────────────────────────────
// For each deal, Claude writes a short INTERNAL triage blurb ("teaser")
// describing how the target fits one of the firm's named investment-criteria
// profiles — and the catch. A firm keeps SEVERAL named profiles, so each deal
// gets one teaser PER profile.
//
// Config lives at Organization.settings.firmTeaser. Generated teasers persist
// in the DealTeaser table (see firm-teaser-migration.sql). The Claude-facing
// generation logic lives in firmTeaserGenerator.ts; shared contract types in
// firmTeaserTypes.ts.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { isClaudeEnabled } from './anthropic.js';
import { getTodayIso } from '../utils/dates.js';
import { getFirmContextBlock } from './firmContextService.js';
import {
  generateSystemPrompt,
  generateTeaser,
  loadDealForTeaser,
  TEASER_MODEL,
} from './firmTeaserGenerator.js';
import type {
  DealTeaser,
  FirmTeaserConfig,
  TeaserCriterion,
  TeaserFit,
  TeaserProfile,
} from './firmTeaserTypes.js';

// Re-export the contract types + preview shape so callers import them from the
// service (the public surface) rather than reaching into internal modules.
export type {
  TeaserCriterion,
  TeaserProfile,
  FirmTeaserConfig,
  TeaserVerdict,
  TeaserFit,
  DealTeaser,
} from './firmTeaserTypes.js';
export type { PreviewProfile } from './firmTeaserGenerator.js';

// ─── Constants (no magic strings) ───────────────────────────────────

const SETTINGS_KEY = 'firmTeaser';
const TABLE = 'DealTeaser';

// ─── Config read/write ──────────────────────────────────────────────

/** Read Organization.settings.firmTeaser, defaulting to an empty profile list. */
export async function getFirmTeaserConfig(orgId: string): Promise<FirmTeaserConfig> {
  const { data: org, error } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();

  if (error) {
    log.error('firmTeaser: getFirmTeaserConfig read failed', error, { orgId });
    throw error;
  }

  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const cfg = settings[SETTINGS_KEY] as FirmTeaserConfig | undefined;
  return cfg && Array.isArray(cfg.profiles) ? cfg : { profiles: [] };
}

/** True when a profile's matching content (systemPrompt + criteria) changed. */
function profileContentChanged(prev: TeaserProfile, next: TeaserProfile): boolean {
  if ((prev.systemPrompt ?? '') !== (next.systemPrompt ?? '')) return true;
  return JSON.stringify(prev.criteria ?? []) !== JSON.stringify(next.criteria ?? []);
}

/**
 * Save the firm-teaser profile list onto Organization.settings (read → spread →
 * update, the same merge pattern as routes/onboarding-firm.ts).
 *
 * Side effects:
 *  - For every profile whose criteria/systemPrompt changed vs the stored copy,
 *    mark that profile's existing DealTeaser rows `stale = true` and bump
 *    `updatedAt`.
 *  - For profiles that were removed, delete their DealTeaser rows.
 */
export async function saveFirmTeaserConfig(
  orgId: string,
  profiles: TeaserProfile[],
): Promise<TeaserProfile[]> {
  const { data: org, error: fetchError } = await supabase
    .from('Organization')
    .select('settings')
    .eq('id', orgId)
    .single();

  if (fetchError) {
    log.error('firmTeaser: saveFirmTeaserConfig read failed', fetchError, { orgId });
    throw fetchError;
  }

  const existingSettings = (org?.settings ?? {}) as Record<string, unknown>;
  const existingCfg = existingSettings[SETTINGS_KEY] as FirmTeaserConfig | undefined;
  const prevProfiles = existingCfg?.profiles ?? [];
  const prevById = new Map(prevProfiles.map((p) => [p.id, p]));

  const nowIso = new Date().toISOString();
  const incomingIds = new Set<string>();
  const changedProfileIds: string[] = [];

  const merged: TeaserProfile[] = profiles.map((incoming) => {
    incomingIds.add(incoming.id);
    const prev = prevById.get(incoming.id);
    const criteria = Array.isArray(incoming.criteria) ? incoming.criteria : [];
    const next: TeaserProfile = {
      id: incoming.id,
      name: incoming.name,
      systemPrompt: incoming.systemPrompt ?? '',
      criteria,
      // Persist the firm context (GEN authoring input). It deliberately does
      // NOT participate in profileContentChanged, so editing it never marks
      // existing teasers stale.
      contextText: incoming.contextText ?? prev?.contextText ?? '',
      updatedAt: incoming.updatedAt ?? nowIso,
    };

    // New profile, or matching content changed → stamp updatedAt + flag stale.
    if (!prev) {
      next.updatedAt = nowIso;
    } else if (profileContentChanged(prev, next)) {
      next.updatedAt = nowIso;
      changedProfileIds.push(incoming.id);
    } else {
      next.updatedAt = prev.updatedAt ?? nowIso;
    }
    return next;
  });

  // Persist the merged config first so the source of truth is up to date even
  // if a follow-up stale/cleanup write hiccups.
  const updatedSettings = { ...existingSettings, [SETTINGS_KEY]: { profiles: merged } };
  const { error: updateError } = await supabase
    .from('Organization')
    .update({ settings: updatedSettings })
    .eq('id', orgId);

  if (updateError) {
    log.error('firmTeaser: saveFirmTeaserConfig update failed', updateError, { orgId });
    throw updateError;
  }

  // Mark stale for profiles whose matching content changed.
  if (changedProfileIds.length > 0) {
    const { error: staleError } = await supabase
      .from(TABLE)
      .update({ stale: true, updatedAt: nowIso })
      .eq('organizationId', orgId)
      .in('profileId', changedProfileIds);
    if (staleError) {
      log.error('firmTeaser: marking teasers stale failed', staleError, { orgId, changedProfileIds });
    }
  }

  // Delete teasers for removed profiles.
  const removedIds = prevProfiles.map((p) => p.id).filter((id) => !incomingIds.has(id));
  if (removedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from(TABLE)
      .delete()
      .eq('organizationId', orgId)
      .in('profileId', removedIds);
    if (deleteError) {
      log.error('firmTeaser: deleting removed-profile teasers failed', deleteError, { orgId, removedIds });
    }
  }

  return merged;
}

// ─── DB helpers ─────────────────────────────────────────────────────

function findProfile(config: FirmTeaserConfig, profileId: string): TeaserProfile | undefined {
  return config.profiles.find((p) => p.id === profileId);
}

/** Upsert a single generated teaser row (unique dealId+profileId), stale=false. */
async function upsertTeaserRow(args: {
  dealId: string;
  orgId: string;
  profile: TeaserProfile;
  headline: string;
  fits: TeaserFit[];
}): Promise<DealTeaser> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(
      {
        dealId: args.dealId,
        organizationId: args.orgId,
        profileId: args.profile.id,
        headline: args.headline,
        fits: args.fits,
        model: TEASER_MODEL,
        stale: false,
        generatedAt: nowIso,
        updatedAt: nowIso,
      },
      { onConflict: 'dealId,profileId' },
    )
    .select('id, dealId, profileId, headline, fits, stale, model, generatedAt')
    .single();

  if (error || !data) {
    log.error('firmTeaser: upsert teaser row failed', error, { dealId: args.dealId, profileId: args.profile.id });
    throw error ?? new Error('Failed to upsert teaser');
  }

  return {
    id: data.id,
    dealId: data.dealId,
    profileId: data.profileId,
    profileName: args.profile.name,
    headline: data.headline,
    fits: (data.fits as TeaserFit[]) ?? [],
    stale: data.stale,
    model: data.model,
    generatedAt: data.generatedAt,
  };
}

// ─── Public service operations ──────────────────────────────────────

/** Expand a profile's criteria + notes into an elaborate system prompt (settings "GEN"). */
export async function generateProfilePrompt(args: {
  name?: string;
  notes?: string;
  criteria: TeaserCriterion[];
  contextText?: string;
}): Promise<string> {
  return generateSystemPrompt({ ...args, today: getTodayIso() });
}

/** Generate or regenerate the teaser for ONE profile and upsert it. */
export async function regenerateDealTeaser(args: {
  dealId: string;
  orgId: string;
  profileId: string;
}): Promise<DealTeaser> {
  const [deal, config] = await Promise.all([
    loadDealForTeaser(args.dealId, args.orgId),
    getFirmTeaserConfig(args.orgId),
  ]);

  const profile = findProfile(config, args.profileId);
  if (!profile) {
    throw new Error(`Profile not found: ${args.profileId}`);
  }

  const { headline, fits } = await generateTeaser({ deal, profile, today: getTodayIso() });

  return upsertTeaserRow({ dealId: args.dealId, orgId: args.orgId, profile, headline, fits });
}

/** List a deal's teasers, attaching profileName from the live config. */
export async function getDealTeasers(dealId: string, orgId: string): Promise<DealTeaser[]> {
  const [{ data, error }, config] = await Promise.all([
    supabase
      .from(TABLE)
      .select('id, dealId, profileId, headline, fits, stale, model, generatedAt')
      .eq('dealId', dealId)
      .eq('organizationId', orgId)
      .order('generatedAt', { ascending: false }),
    getFirmTeaserConfig(orgId),
  ]);

  if (error) {
    log.error('firmTeaser: getDealTeasers failed', error, { dealId, orgId });
    throw error;
  }

  const nameById = new Map(config.profiles.map((p) => [p.id, p.name]));

  return (data ?? []).map((row) => ({
    id: row.id,
    dealId: row.dealId,
    profileId: row.profileId,
    // Keep rows whose profile was deleted, with a clear fallback name.
    profileName: nameById.get(row.profileId) ?? 'Removed profile',
    headline: row.headline,
    fits: (row.fits as TeaserFit[]) ?? [],
    stale: row.stale,
    model: row.model,
    generatedAt: row.generatedAt,
  }));
}

/**
 * Generate teasers for ALL profiles of an org for a freshly-created deal.
 * Best-effort: one failing profile must not throw. No-op when no profiles or
 * Claude is disabled. Used by auto-gen-on-create (blocks the ingest response).
 */
export async function generateTeasersForDeal(args: { dealId: string; orgId: string }): Promise<void> {
  const config = await getFirmTeaserConfig(args.orgId);
  if (!config.profiles.length) {
    log.debug('firmTeaser: no profiles configured, skipping auto-gen', { orgId: args.orgId, dealId: args.dealId });
    return;
  }

  if (!isClaudeEnabled()) {
    log.warn('firmTeaser: Claude disabled, skipping auto-gen', { orgId: args.orgId, dealId: args.dealId });
    return;
  }

  const deal = await loadDealForTeaser(args.dealId, args.orgId);
  const today = getTodayIso();

  // Firm-wide standing context (single AI-generated firm-context doc). Empty
  // when none generated yet — passed through to generateTeaser, which guards
  // the empty case and prepends nothing.
  const firmContext = await getFirmContextBlock(args.orgId);

  const results = await Promise.allSettled(
    config.profiles.map(async (profile) => {
      const { headline, fits } = await generateTeaser({ deal, profile, today, firmContext });
      await upsertTeaserRow({ dealId: args.dealId, orgId: args.orgId, profile, headline, fits });
    }),
  );

  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  for (const f of failed) {
    log.error('firmTeaser: per-profile auto-gen failed', f.reason, { dealId: args.dealId, orgId: args.orgId });
  }
  log.info('firmTeaser: auto-gen complete', {
    dealId: args.dealId,
    orgId: args.orgId,
    total: config.profiles.length,
    failed: failed.length,
  });
}

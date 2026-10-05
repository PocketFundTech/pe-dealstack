// ─── Per-org Outreach pipeline settings ───────────────────────────────
//
// One row per org in OutreachSettings (cicero-outreach-settings-migration.sql),
// created lazily with defaults on first read rather than seeded by the
// migration — a brand-new org (see the pocket-fund/cicero-capital-test
// isolated test orgs) never needs a manual seed step for this table the
// way OutreachStage does. "Reset to defaults" is just deleting the row;
// the next read recreates it with defaults.

import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';

export interface OutreachSettings {
  staleDays: number;
  autoAdvanceSourceToEnrich: boolean;
  autoAdvanceEnrichToSend: boolean;
  autoAdvanceSendToHandleReply: boolean;
}

export const DEFAULT_OUTREACH_SETTINGS: OutreachSettings = {
  staleDays: 21,
  autoAdvanceSourceToEnrich: true,
  autoAdvanceEnrichToSend: true,
  autoAdvanceSendToHandleReply: true,
};

/** Never throws — a lookup failure falls back to defaults rather than
 *  breaking the enrich/send flows that depend on this to decide whether
 *  to auto-advance a contact's stage. Settings are a convenience knob,
 *  not a security boundary, so failing open here is the right call
 *  (unlike requireOrgSlug's fail-closed stance in orgScope.ts). */
export async function getOutreachSettings(orgId: string): Promise<OutreachSettings> {
  try {
    const { data, error } = await supabase
      .from('OutreachSettings')
      .select('staleDays, autoAdvanceSourceToEnrich, autoAdvanceEnrichToSend, autoAdvanceSendToHandleReply')
      .eq('organizationId', orgId)
      .maybeSingle();

    if (error) {
      log.warn('outreachSettingsService: failed to load settings, using defaults', { orgId, error: error.message });
      return DEFAULT_OUTREACH_SETTINGS;
    }
    if (!data) return DEFAULT_OUTREACH_SETTINGS;

    return {
      staleDays: data.staleDays,
      autoAdvanceSourceToEnrich: data.autoAdvanceSourceToEnrich,
      autoAdvanceEnrichToSend: data.autoAdvanceEnrichToSend,
      autoAdvanceSendToHandleReply: data.autoAdvanceSendToHandleReply,
    };
  } catch (err) {
    log.error('outreachSettingsService: getOutreachSettings threw', err, { orgId });
    return DEFAULT_OUTREACH_SETTINGS;
  }
}

export async function upsertOutreachSettings(
  orgId: string,
  patch: Partial<OutreachSettings>,
): Promise<OutreachSettings> {
  const current = await getOutreachSettings(orgId);
  const next = { ...current, ...patch };

  const { error } = await supabase
    .from('OutreachSettings')
    .upsert(
      { organizationId: orgId, ...next, updatedAt: new Date().toISOString() },
      { onConflict: 'organizationId' },
    );

  if (error) throw error;
  return next;
}

export async function resetOutreachSettings(orgId: string): Promise<OutreachSettings> {
  const { error } = await supabase.from('OutreachSettings').delete().eq('organizationId', orgId);
  if (error) throw error;
  return DEFAULT_OUTREACH_SETTINGS;
}

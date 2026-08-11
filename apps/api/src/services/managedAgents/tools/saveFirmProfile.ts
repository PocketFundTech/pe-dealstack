import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';

interface SaveFirmProfileInput {
  firm?: {
    description?: string;
    strategy?: string;
    sectors?: string[];
    checkSizeRange?: string;
    aum?: string;
    teamSize?: string;
    headquarters?: string;
    foundedYear?: string;
    investmentCriteria?: string[];
    keyDifferentiators?: string[];
    portfolioCompanies?: Array<{ name: string; sector?: string }>;
    recentDeals?: Array<{ company: string; description?: string }>;
    sources?: string[];
  };
  person?: {
    title?: string;
    bio?: string;
    experience?: string;
    linkedinUrl?: string;
  };
}

function dedupeBy<T extends Record<string, any>>(items: T[], key: string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const k = String(item[key] ?? '').toLowerCase();
    if (k) seen.set(k, item);
  }
  return Array.from(seen.values());
}

export async function saveFirmProfile(
  organizationId: string,
  input: SaveFirmProfileInput,
): Promise<{ saved: boolean }> {
  if (!organizationId) return { saved: false };

  const { data: org } = await supabase.from('Organization').select('settings').eq('id', organizationId).single();

  const settings = (org?.settings || {}) as Record<string, any>;
  const existing = settings.firmProfile || {};
  const merged: Record<string, any> = { ...existing };

  if (input.firm) {
    for (const [key, value] of Object.entries(input.firm)) {
      if (value === undefined) continue;
      if (key === 'portfolioCompanies' && Array.isArray(value)) {
        merged.portfolioCompanies = dedupeBy([...(existing.portfolioCompanies || []), ...value], 'name');
      } else if (key === 'recentDeals' && Array.isArray(value)) {
        merged.recentDeals = dedupeBy([...(existing.recentDeals || []), ...value], 'company');
      } else if (Array.isArray(value)) {
        merged[key] = Array.from(new Set([...(existing[key] || []), ...value]));
      } else {
        merged[key] = value;
      }
    }
  }
  merged.enrichedAt = new Date().toISOString();

  settings.firmProfile = merged;
  settings.researchStatus = 'running';
  if (input.person) {
    settings.personProfile = { ...(settings.personProfile || {}), ...input.person };
  }

  const { error } = await supabase.from('Organization').update({ settings }).eq('id', organizationId);
  if (error) {
    log.error('save_firm_profile: failed to persist', { organizationId, error: error.message });
    return { saved: false };
  }
  return { saved: true };
}

import { supabase } from '../supabase.js';
import { ConflictError, DatabaseError, NotFoundError } from '../middleware/errorHandler.js';
import { buildSearchPreset, readSearchProfile, searchPresetBrief, type SearchAnswers } from './searchPreset.js';
import { buildSearchDraft, readSearchSetup, type SearchDraft } from './searchSetup.js';
const ATTEMPTS = 3;
async function load(orgId: string) {
  const { data, error } = await supabase.from('Organization').select('settings').eq('id',orgId).single();
  if (error) throw new DatabaseError('Could not read organization settings.');
  if (!data) throw new NotFoundError('Organization');
  return data.settings as Record<string, unknown> | null;
}
export async function getSearchPreset(orgId: string) {
  const settings = await load(orgId), profile = readSearchProfile(settings || {});
  return { searchProfile: profile, searchSetup:readSearchSetup(settings || {}), brief: profile ? searchPresetBrief(profile.answers) : '' };
}
async function updateSettings<T>(orgId: string, build: (settings: Record<string, unknown>) => { settings: Record<string,unknown>; result:T }) {
  // Compare-and-swap the JSON settings so concurrent settings edits survive.
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const previous = await load(orgId);
    const { settings, result } = build(previous || {});
    let update = supabase.from('Organization').update({ settings }).eq('id',orgId);
    update = previous === null ? update.is('settings',null) : update.eq('settings',JSON.stringify(previous));
    const { data, error } = await update.select('id').maybeSingle();
    if (error) throw new DatabaseError('Could not save search setup.');
    if (data) return result;
  }
  throw new ConflictError('Firm settings changed while saving. Please try again.');
}
export async function applySearchPreset(orgId: string, answers: SearchAnswers) {
  return updateSettings(orgId, previous => {
    const built = buildSearchPreset(previous, answers);
    const searchSetup = {status:'complete',draft:null,updatedAt:new Date().toISOString()};
    return { settings:{...built.settings,searchSetup}, result:{searchProfile:built.settings.searchProfile,searchSetup,brief:built.brief,warnings:built.warnings} };
  });
}
export async function saveSearchDraft(orgId: string, draft: SearchDraft, skip = false) {
  return updateSettings(orgId, previous => {
    const settings = buildSearchDraft(previous,draft,skip);
    return {settings,result:{searchSetup:settings.searchSetup}};
  });
}

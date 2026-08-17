// apps/api/src/services/agents/firmResearchAgent/nodes/save.ts
import { FirmResearchStateType, AgentStep } from '../state.js';
import { supabase } from '../../../../supabase.js';
import { log } from '../../../../utils/logger.js';
import { captureAgentError } from '../../../../utils/sentryHelpers.js';

function step(message: string, detail?: string): AgentStep {
  return { timestamp: new Date().toISOString(), node: 'save', message, detail };
}

export async function saveNode(
  state: FirmResearchStateType,
): Promise<Partial<FirmResearchStateType>> {
  const steps: AgentStep[] = [];

  // Save firm profile to Organization.settings
  if (state.firmProfile && state.organizationId) {
    try {
      const { data: org } = await supabase
        .from('Organization')
        .select('settings, website')
        .eq('id', state.organizationId)
        .single();

      const existingSettings = (org?.settings || {}) as Record<string, any>;

      // Merge with existing — manual overrides take precedence
      const existingProfile = existingSettings.firmProfile || {};
      const mergedProfile = { ...state.firmProfile };

      // Preserve manually overridden fields
      for (const [key, val] of Object.entries(existingProfile)) {
        if (existingProfile[`${key}_manualOverride`] === true) {
          (mergedProfile as any)[key] = val;
        }
      }

      // Build audit trail (keep last 5 runs)
      const history = existingSettings.enrichmentHistory || [];
      history.unshift({
        timestamp: new Date().toISOString(),
        sources: state.sources,
        confidence: state.firmProfile.confidence,
        fieldsPopulated: Object.entries(state.firmProfile)
          .filter(([, v]) => v && (typeof v === 'string' ? v.length > 0 : true))
          .map(([k]) => k),
      });

      const updatedSettings = {
        ...existingSettings,
        firmProfile: mergedProfile,
        firmWebsite: state.websiteUrl || existingSettings.firmWebsite,
        firmLinkedin: state.linkedinUrl || existingSettings.firmLinkedin,
        enrichedAt: new Date().toISOString(),
        enrichmentSources: state.sources,
        enrichmentHistory: history.slice(0, 5),
      };

      await supabase
        .from('Organization')
        .update({
          website: state.websiteUrl || org?.website,
          settings: updatedSettings,
        })
        .eq('id', state.organizationId);

      steps.push(step('Firm profile saved to Organization'));
    } catch (error) {
      steps.push(step('Failed to save firm profile', (error as Error).message));
      log.error('Save firm profile failed', { error: (error as Error).message });
      captureAgentError(error, { agent: 'firmResearchAgent', node: 'save.firm' });
    }
  }

  // Save person profile to User.onboardingStatus
  if (state.personProfile && state.userId) {
    try {
      const { data: user } = await supabase
        .from('User')
        .select('onboardingStatus')
        .eq('authId', state.userId)
        .single();

      const status = (user?.onboardingStatus || {}) as Record<string, any>;
      status.personProfile = state.personProfile;

      await supabase
        .from('User')
        .update({ onboardingStatus: status })
        .eq('authId', state.userId);

      steps.push(step('Person profile saved to User'));
    } catch (error) {
      steps.push(step('Failed to save person profile', (error as Error).message));
      log.error('Save person profile failed', { error: (error as Error).message });
      captureAgentError(error, { agent: 'firmResearchAgent', node: 'save.person' });
    }
  }

  return { status: 'complete', steps };
}

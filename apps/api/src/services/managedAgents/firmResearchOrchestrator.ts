import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { captureAgentError } from '../../utils/sentryHelpers.js';
import { createSessionAndDrain } from './session.js';
import { acquireResearchLock, releaseResearchLock } from './researchLock.js';
import { recordManagedAgentSessionUsage } from '../usage/trackedManagedAgentSession.js';
import { saveFirmProfile } from './tools/saveFirmProfile.js';
import { FIRM_RESEARCH_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID, assertManagedAgentsConfigured } from './config.js';

export interface RunFirmResearchInput {
  organizationId: string;
  firmName: string;
  websiteUrl: string;
  linkedinUrl: string;
}

export async function runFirmResearchViaManagedAgents(input: RunFirmResearchInput): Promise<void> {
  assertManagedAgentsConfigured();
  const acquired = await acquireResearchLock(input.organizationId);
  if (!acquired) {
    log.info('Firm research skipped — already running for this org', { organizationId: input.organizationId });
    return;
  }

  const start = Date.now();
  try {
    const result = await createSessionAndDrain({
      agentId: FIRM_RESEARCH_AGENT_ID,
      environmentId: MANAGED_AGENTS_ENVIRONMENT_ID,
      organizationId: input.organizationId,
      initialMessage: `Research this firm. Website: ${input.websiteUrl || 'unknown'}. LinkedIn: ${input.linkedinUrl || 'unknown'}. Firm name (if known): ${input.firmName || 'unknown'}.`,
      toolHandlers: { save_firm_profile: saveFirmProfile },
    });

    await recordManagedAgentSessionUsage({
      operation: 'firm_research_managed_agent',
      status: result.status === 'completed' ? 'success' : 'error',
      usage: result.usage,
      durationMs: Date.now() - start,
      costOverrideUsd: result.costOverrideUsd,
      model: result.model,
      webSearchRequests: result.webSearchRequests,
      activeSeconds: result.activeSeconds,
    });

    if (result.status === 'failed') {
      await markResearchFailed(input.organizationId, result.error || 'unknown error');
    }
  } catch (err) {
    // createSessionAndDrain no longer throws once a session exists — it
    // catches its own event-loop errors and still returns a 'failed' result
    // with the session's final usage attached (see session.ts finalize()).
    // This catch is now reached only when the session was never created
    // (e.g. sessions.create() itself failed), so there is no billable usage
    // to record here.
    captureAgentError(err, { context: 'firmResearchOrchestrator:runFirmResearchViaManagedAgents' });
    await markResearchFailed(input.organizationId, err instanceof Error ? err.message : String(err));
  } finally {
    await releaseResearchLock(input.organizationId);
  }
}

async function markResearchFailed(organizationId: string, error: string): Promise<void> {
  const { data: org } = await supabase.from('Organization').select('settings').eq('id', organizationId).single();
  const settings = (org?.settings || {}) as Record<string, any>;
  settings.researchStatus = 'failed';
  settings.researchError = error;
  await supabase.from('Organization').update({ settings }).eq('id', organizationId);
}

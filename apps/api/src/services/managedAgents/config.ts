export const MANAGED_AGENTS_ENVIRONMENT_ID = process.env.MANAGED_AGENTS_ENVIRONMENT_ID || '';
export const FIRM_RESEARCH_AGENT_ID = process.env.MANAGED_AGENTS_FIRM_RESEARCH_AGENT_ID || '';
export const SIGNAL_MONITOR_AGENT_ID = process.env.MANAGED_AGENTS_SIGNAL_MONITOR_AGENT_ID || '';

export function assertManagedAgentsConfigured(): void {
  if (!MANAGED_AGENTS_ENVIRONMENT_ID || !FIRM_RESEARCH_AGENT_ID || !SIGNAL_MONITOR_AGENT_ID) {
    throw new Error(
      'Managed Agents env vars missing — run apps/api/managed-agents/setup.sh and set ' +
        'MANAGED_AGENTS_ENVIRONMENT_ID / MANAGED_AGENTS_FIRM_RESEARCH_AGENT_ID / MANAGED_AGENTS_SIGNAL_MONITOR_AGENT_ID',
    );
  }
}

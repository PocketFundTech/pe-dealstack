import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const AGENTS_DIR = join(__dirname, '../managed-agents');

describe('managed-agents YAML configs', () => {
  it('firm-research-agent.agent.yaml declares save_firm_profile with a matching tool name', () => {
    const yaml = readFileSync(join(AGENTS_DIR, 'firm-research-agent.agent.yaml'), 'utf-8');
    expect(yaml).toContain('name: save_firm_profile');
    expect(yaml).toContain('type: custom');
    expect(yaml).toContain('agent_toolset_20260401');
  });

  it('signal-monitor-agent.agent.yaml declares both custom tools', () => {
    const yaml = readFileSync(join(AGENTS_DIR, 'signal-monitor-agent.agent.yaml'), 'utf-8');
    expect(yaml).toContain('name: list_deals_for_org');
    expect(yaml).toContain('name: create_signal_notification');
  });

  it('research-signals.environment.yaml declares a cloud environment', () => {
    const yaml = readFileSync(join(AGENTS_DIR, 'research-signals.environment.yaml'), 'utf-8');
    expect(yaml).toContain('type: cloud');
  });
});

describe('assertManagedAgentsConfigured', () => {
  const ENV_KEYS = [
    'MANAGED_AGENTS_ENVIRONMENT_ID',
    'MANAGED_AGENTS_FIRM_RESEARCH_AGENT_ID',
    'MANAGED_AGENTS_SIGNAL_MONITOR_AGENT_ID',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws when any env var is missing', async () => {
    const { assertManagedAgentsConfigured } = await import('../src/services/managedAgents/config.js');
    expect(() => assertManagedAgentsConfigured()).toThrow(/Managed Agents env vars missing/);
  });
});

# Research & Signals on Managed Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the firm-research LangGraph agent (fast pass + deep pass) and the on-demand signal-monitor LangGraph agent with two Anthropic Managed Agents, both gated behind independent feature flags with the legacy path fully intact.

**Architecture:** Two Managed Agents (Firm Research, Signal Monitor) share one `cloud` Environment. A shared session driver (`services/managedAgents/session.ts`) creates a session, opens its event stream, sends the kickoff message, and drains events — dispatching `agent.custom_tool_use` calls to per-feature tool handlers that read/write Supabase with the same org-scoping the REST routes already enforce. Firm research runs fire-and-forget from `POST /api/onboarding/enrich-firm`; signal monitoring runs both on-demand (`POST /api/ai/scan-signals`) and nightly via a nightly Vercel Cron fan-out that creates one isolated session per active org.

**Tech Stack:** `@anthropic-ai/sdk` (`client.beta.agents` / `client.beta.sessions` / `client.beta.environments` / `client.beta.webhooks`), Express, Supabase (`pg`/`supabase-js`), Vitest, `ant` CLI for agent/environment provisioning.

---

## File Structure

**New files:**
- `apps/api/managed-agents/research-signals.environment.yaml` — shared cloud Environment config
- `apps/api/managed-agents/firm-research-agent.agent.yaml` — Firm Research Agent config
- `apps/api/managed-agents/signal-monitor-agent.agent.yaml` — Signal Monitor Agent config
- `apps/api/managed-agents/setup.sh` — one-time `ant` CLI provisioning script
- `apps/api/managed-agents-migration.sql` — adds `Organization.researchLockedAt`
- `apps/api/src/services/managedAgents/config.ts` — env-driven agent/environment ID + model config
- `apps/api/src/services/managedAgents/session.ts` — session create/drain/tool-dispatch driver, usage accumulation
- `apps/api/src/services/managedAgents/toolHandlers.ts` — tool-name → handler registry per agent
- `apps/api/src/services/managedAgents/tools/saveFirmProfile.ts` — `save_firm_profile` custom tool
- `apps/api/src/services/managedAgents/tools/listDealsForOrg.ts` — `list_deals_for_org` custom tool
- `apps/api/src/services/managedAgents/tools/createSignalNotification.ts` — `create_signal_notification` custom tool
- `apps/api/src/services/managedAgents/researchLock.ts` — per-org concurrency lock for firm research
- `apps/api/src/services/managedAgents/firmResearchOrchestrator.ts` — `runFirmResearchViaManagedAgents()`
- `apps/api/src/services/managedAgents/signalMonitorOrchestrator.ts` — `runSignalMonitorViaManagedAgents()`
- `apps/api/src/services/usage/trackedManagedAgentSession.ts` — records a `UsageEvent` for a completed session
- `apps/api/src/routes/managed-agents-webhooks.ts` — Anthropic webhook receiver (`session.status_terminated` → `researchStatus`)
- `apps/api/src/routes/cron-signal-scan.ts` — nightly Vercel Cron fan-out endpoint
- `apps/api/tests/*.test.ts` — one test file per task (named below)

**Modified files:**
- `apps/api/src/routes/onboarding.ts` — `enrich-firm` gated by `RESEARCH_ENGINE`
- `apps/api/src/routes/ai-agents.ts` — `scan-signals` gated by `SIGNAL_ENGINE`
- `apps/api/src/app.ts` — mount the webhook route (raw body, before `express.json()`) and the cron route
- `vercel.json` — add the nightly cron entry
- `apps/api/.env.example` — document the new env vars

---

### Task 1: Provisioning config + concurrency-lock migration

**Files:**
- Create: `apps/api/managed-agents/research-signals.environment.yaml`
- Create: `apps/api/managed-agents/firm-research-agent.agent.yaml`
- Create: `apps/api/managed-agents/signal-monitor-agent.agent.yaml`
- Create: `apps/api/managed-agents/setup.sh`
- Create: `apps/api/managed-agents-migration.sql`
- Create: `apps/api/src/services/managedAgents/config.ts`
- Test: `apps/api/tests/managed-agents-config.test.ts`

This task has no red/green code cycle (YAML + SQL + a pure config module) — write the files, then a structural test that catches typos/renames before they reach `ant`.

- [ ] **Step 1: Write the environment YAML**

```yaml
# apps/api/managed-agents/research-signals.environment.yaml
name: research-signals-env
description: Shared cloud environment for the Firm Research and Signal Monitor Managed Agents. Neither agent needs filesystem/shell access — only web_search, web_fetch, and the custom DB tools declared on each agent.
config:
  type: cloud
  networking:
    type: unrestricted
```

- [ ] **Step 2: Write the Firm Research Agent YAML**

```yaml
# apps/api/managed-agents/firm-research-agent.agent.yaml
name: firm-research-agent
description: Researches a PE/M&A firm and its principals from a website/LinkedIn URL, saving findings progressively via save_firm_profile
model: claude-sonnet-5
system: |
  You are a private-equity research analyst. Given a firm's website URL
  and/or LinkedIn URL, research the firm and its key people: description,
  strategy, sectors, check size range, AUM, team size, headquarters,
  founded year, investment criteria, key differentiators, portfolio
  companies, and recent deals.

  Call save_firm_profile every time you learn something material — do not
  wait until you are completely done. If you cannot find something, omit
  it rather than guessing. When you believe research is complete, call
  save_firm_profile one final time and stop.
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
    configs:
      - name: web_search
        enabled: true
      - name: web_fetch
        enabled: true
  - type: custom
    name: save_firm_profile
    description: Save or update firm/person research findings for this organization. Call this every time you learn something material, not only when finished.
    input_schema:
      type: object
      properties:
        firm:
          type: object
          properties:
            description: { type: string }
            strategy: { type: string }
            sectors: { type: array, items: { type: string } }
            checkSizeRange: { type: string }
            aum: { type: string }
            teamSize: { type: string }
            headquarters: { type: string }
            foundedYear: { type: string }
            investmentCriteria: { type: array, items: { type: string } }
            keyDifferentiators: { type: array, items: { type: string } }
            portfolioCompanies:
              type: array
              items:
                type: object
                properties:
                  name: { type: string }
                  sector: { type: string }
                required: [name]
            recentDeals:
              type: array
              items:
                type: object
                properties:
                  company: { type: string }
                  description: { type: string }
                required: [company]
            sources: { type: array, items: { type: string } }
        person:
          type: object
          properties:
            title: { type: string }
            bio: { type: string }
            experience: { type: string }
            linkedinUrl: { type: string }
      required: []
```

- [ ] **Step 3: Write the Signal Monitor Agent YAML**

```yaml
# apps/api/managed-agents/signal-monitor-agent.agent.yaml
name: signal-monitor-agent
description: Analyzes an organization's active deals for risks, opportunities, and required actions, flagging signals via create_signal_notification
model: claude-sonnet-5
system: |
  You are a PE deal monitoring system. Call list_deals_for_org first to get
  the organization's active portfolio deals. Analyze them for risks,
  opportunities, or required actions based on their current status,
  industry, and deal lifecycle stage.

  Signal types: leadership_change, financial_event, market_shift,
  competitive_threat, regulatory_change, growth_opportunity,
  risk_escalation, milestone_approaching.

  Generate 1-3 signals per deal, focusing on the most actionable ones.
  Only generate signals realistic for the deal's industry and stage. Call
  create_signal_notification once per signal worth surfacing — only for
  critical or warning severity, skip info-only observations. When you have
  evaluated every deal, stop.
tools:
  - type: agent_toolset_20260401
    default_config:
      enabled: false
  - type: custom
    name: list_deals_for_org
    description: List this organization's active (non-passed, non-closed-lost) deals with basic details. Call this first, with no arguments.
    input_schema:
      type: object
      properties: {}
      required: []
  - type: custom
    name: create_signal_notification
    description: Record a signal found for a specific deal. Only call for critical or warning severity signals.
    input_schema:
      type: object
      properties:
        dealId: { type: string }
        signalType:
          type: string
          enum: [leadership_change, financial_event, market_shift, competitive_threat, regulatory_change, growth_opportunity, risk_escalation, milestone_approaching]
        severity:
          type: string
          enum: [critical, warning, info]
        title: { type: string }
        description: { type: string }
        suggestedAction: { type: string }
      required: [dealId, signalType, severity, title, description, suggestedAction]
```

- [ ] **Step 4: Write the `ant` CLI setup script**

```bash
#!/usr/bin/env bash
# One-time provisioning for the Research & Signals Managed Agents.
# Run manually (never in CI/deploy) — agents and environments are persistent,
# versioned resources; re-running `create` against an existing name 409s.
# Requires the ant CLI authenticated — see shared/anthropic-cli.md.
set -euo pipefail
cd "$(dirname "$0")"

ENV_ID=$(ant beta:environments create < research-signals.environment.yaml --transform id -r)
echo "Environment: $ENV_ID"

FIRM_RESEARCH_AGENT_ID=$(ant beta:agents create < firm-research-agent.agent.yaml --transform id -r)
echo "Firm research agent: $FIRM_RESEARCH_AGENT_ID"

SIGNAL_MONITOR_AGENT_ID=$(ant beta:agents create < signal-monitor-agent.agent.yaml --transform id -r)
echo "Signal monitor agent: $SIGNAL_MONITOR_AGENT_ID"

cat <<EOF

Add these to Vercel env (all environments):
MANAGED_AGENTS_ENVIRONMENT_ID=$ENV_ID
MANAGED_AGENTS_FIRM_RESEARCH_AGENT_ID=$FIRM_RESEARCH_AGENT_ID
MANAGED_AGENTS_SIGNAL_MONITOR_AGENT_ID=$SIGNAL_MONITOR_AGENT_ID
EOF
```

```bash
chmod +x apps/api/managed-agents/setup.sh
```

- [ ] **Step 5: Write the migration SQL**

```sql
-- apps/api/managed-agents-migration.sql
-- Research concurrency lock: prevents two enrich-firm runs racing for the
-- same org across serverless instances. The prior guard (an in-process
-- Set in firmResearchAgent/index.ts) explicitly could not do this — see
-- design spec §3.2.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "researchLockedAt" timestamptz;
```

- [ ] **Step 6: Write the config module**

```ts
// apps/api/src/services/managedAgents/config.ts
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
```

- [ ] **Step 7: Write the structural test**

```ts
// apps/api/tests/managed-agents-config.test.ts
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
```

- [ ] **Step 8: Run the test**

```bash
cd apps/api && npx vitest run tests/managed-agents-config.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/api/managed-agents apps/api/managed-agents-migration.sql apps/api/src/services/managedAgents/config.ts apps/api/tests/managed-agents-config.test.ts
git commit -m "feat(managed-agents): provisioning YAML, setup script, concurrency-lock migration"
```

---

### Task 2: Session driver — create, drain, dispatch custom tools

**Files:**
- Create: `apps/api/src/services/managedAgents/session.ts`
- Test: `apps/api/tests/managed-agents-session.test.ts`

This is the shared core both orchestrators call. It creates a session, opens the stream *before* sending the kickoff message — the session cannot exist until `sessions.create()` returns, so create-then-stream-then-send has an unavoidable gap; closing it means also reading full history and deduping by event ID (`shared/managed-agents-client-patterns.md` Pattern 1 + Pattern 7), not just stream-first alone.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentEvents: any[] = [];
let historyEvents: any[] = [];
let liveEvents: any[] = [];

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      sessions: {
        create: vi.fn(async () => ({ id: 'sesn_test1', status: 'idle' })),
        events: {
          send: vi.fn(async (_id: string, body: any) => {
            sentEvents.push(...body.events);
          }),
          list: vi.fn(async function* () {
            for (const e of historyEvents) yield e;
          }),
          stream: vi.fn(async function* () {
            for (const e of liveEvents) yield e;
          }),
        },
      },
    };
  }
  return { default: MockAnthropic };
});

async function getSession() {
  return await import('../src/services/managedAgents/session.js');
}

beforeEach(() => {
  sentEvents.length = 0;
  historyEvents = [];
  liveEvents = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('createSessionAndDrain', () => {
  it('sends the kickoff message and returns completed on a terminal idle event', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'session.status_running' },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'Research this firm',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({ type: 'user.message' });
  });

  it('dispatches agent.custom_tool_use to the matching handler and submits the result', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'agent.custom_tool_use', name: 'save_firm_profile', input: { firm: { description: 'x' } } },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const handler = vi.fn(async () => ({ saved: true }));
    const { createSessionAndDrain } = await getSession();

    await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'Research this firm',
      toolHandlers: { save_firm_profile: handler },
    });

    expect(handler).toHaveBeenCalledWith('org_1', { firm: { description: 'x' } });
    const resultEvent = sentEvents.find((e) => e.type === 'user.custom_tool_result');
    expect(resultEvent).toMatchObject({ custom_tool_use_id: 'sevt_1' });
  });

  it('continues past requires_action idle and only stops on a terminal idle', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'agent.custom_tool_use', name: 'noop_tool', input: {} },
      { id: 'sevt_2', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_1'] } },
      { id: 'sevt_3', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('completed');
  });

  it('accumulates token usage from span.model_request_end events', async () => {
    liveEvents = [
      { id: 'sevt_1', type: 'span.model_request_end', model_usage: { input_tokens: 100, output_tokens: 20 } },
      { id: 'sevt_2', type: 'span.model_request_end', model_usage: { input_tokens: 50, output_tokens: 10 } },
      { id: 'sevt_3', type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 30 });
  });

  it('returns failed when the stream ends with no terminal event', async () => {
    liveEvents = [{ id: 'sevt_1', type: 'session.status_running' }];
    const { createSessionAndDrain } = await getSession();

    const result = await createSessionAndDrain({
      agentId: 'agent_1',
      environmentId: 'env_1',
      organizationId: 'org_1',
      initialMessage: 'go',
      toolHandlers: {},
    });

    expect(result.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-session.test.ts
```

Expected: FAIL — `Cannot find module '../src/services/managedAgents/session.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/managedAgents/session.ts
import { getAnthropicClient } from '../ai/client.js';
import { log } from '../../utils/logger.js';

export type ToolHandler = (organizationId: string, input: any) => Promise<unknown>;

export interface DrainSessionResult {
  status: 'completed' | 'failed';
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface CreateSessionAndDrainParams {
  agentId: string;
  environmentId: string;
  organizationId: string;
  initialMessage: string;
  toolHandlers: Record<string, ToolHandler>;
}

export async function createSessionAndDrain(params: CreateSessionAndDrainParams): Promise<DrainSessionResult> {
  const client = getAnthropicClient();
  const session = await client.beta.sessions.create({
    agent: params.agentId,
    environment_id: params.environmentId,
  });

  const usage = { inputTokens: 0, outputTokens: 0 };
  const seen = new Set<string>();

  // Stream-first (shared/managed-agents-client-patterns.md Pattern 7), plus
  // history + dedupe (Pattern 1) — the session can't exist before create()
  // returns, so there is always a gap between session creation and the
  // stream opening; only reading history closes it.
  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: params.initialMessage }] }],
  });

  const handleEvent = async (event: any): Promise<DrainSessionResult | null> => {
    if (seen.has(event.id)) return null;
    seen.add(event.id);

    if (event.type === 'span.model_request_end' && event.model_usage) {
      usage.inputTokens += event.model_usage.input_tokens ?? 0;
      usage.outputTokens += event.model_usage.output_tokens ?? 0;
    }

    if (event.type === 'agent.custom_tool_use') {
      const handler = params.toolHandlers[event.name];
      let result: unknown;
      if (!handler) {
        result = { error: `Unknown tool: ${event.name}` };
      } else {
        try {
          result = await handler(params.organizationId, event.input);
        } catch (err) {
          log.error('managed-agents custom tool handler threw', {
            tool: event.name,
            organizationId: params.organizationId,
            error: err instanceof Error ? err.message : String(err),
          });
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: event.id,
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        ],
      });
      return null;
    }

    if (event.type === 'session.status_terminated') {
      return { status: 'completed', usage };
    }
    if (event.type === 'session.status_idle') {
      if (event.stop_reason?.type === 'requires_action') return null;
      return { status: 'completed', usage };
    }
    return null;
  };

  for await (const event of client.beta.sessions.events.list(session.id)) {
    const result = await handleEvent(event);
    if (result) return result;
  }
  for await (const event of stream) {
    const result = await handleEvent(event);
    if (result) return result;
  }

  return { status: 'failed', error: 'Stream ended without a terminal event', usage };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-session.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/managedAgents/session.ts apps/api/tests/managed-agents-session.test.ts
git commit -m "feat(managed-agents): session create/drain/tool-dispatch driver"
```

---

### Task 3: Custom tool — `save_firm_profile`

**Files:**
- Create: `apps/api/src/services/managedAgents/tools/saveFirmProfile.ts`
- Test: `apps/api/tests/managed-agents-save-firm-profile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-save-firm-profile.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function getTool() {
  return await import('../src/services/managedAgents/tools/saveFirmProfile.js');
}

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('saveFirmProfile', () => {
  it('merges new firm fields into an empty settings.firmProfile', async () => {
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'Organization') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: { settings: {} }, error: null }) }),
          }),
          update: (payload: any) => {
            updatedSettings = payload.settings;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const { saveFirmProfile } = await getTool();
    const result = await saveFirmProfile('org-1', { firm: { description: 'A PE firm', sectors: ['SaaS'] } });

    expect(result).toEqual({ saved: true });
    expect(updatedSettings.firmProfile.description).toBe('A PE firm');
    expect(updatedSettings.firmProfile.sectors).toEqual(['SaaS']);
    expect(updatedSettings.researchStatus).toBe('running');
  });

  it('dedupes portfolio companies by lowercased name across calls', async () => {
    let storedSettings: any = { firmProfile: { portfolioCompanies: [{ name: 'Acme Co' }] } };
    mockSupabase.from.mockImplementation((table: string) => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: storedSettings }, error: null }) }) }),
      update: (payload: any) => {
        storedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { saveFirmProfile } = await getTool();
    await saveFirmProfile('org-1', {
      firm: { portfolioCompanies: [{ name: 'acme co', sector: 'Fintech' }, { name: 'Beta Inc' }] },
    });

    expect(storedSettings.firmProfile.portfolioCompanies).toHaveLength(2);
    const names = storedSettings.firmProfile.portfolioCompanies.map((c: any) => c.name.toLowerCase());
    expect(names).toContain('acme co');
    expect(names).toContain('beta inc');
  });

  it('returns saved: false without calling Supabase when organizationId is empty', async () => {
    const { saveFirmProfile } = await getTool();
    const result = await saveFirmProfile('', { firm: { description: 'x' } });
    expect(result).toEqual({ saved: false });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-save-firm-profile.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/managedAgents/tools/saveFirmProfile.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-save-firm-profile.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/managedAgents/tools/saveFirmProfile.ts apps/api/tests/managed-agents-save-firm-profile.test.ts
git commit -m "feat(managed-agents): save_firm_profile custom tool"
```

---

### Task 4: Custom tools — `list_deals_for_org` + `create_signal_notification`

**Files:**
- Create: `apps/api/src/services/managedAgents/tools/listDealsForOrg.ts`
- Create: `apps/api/src/services/managedAgents/tools/createSignalNotification.ts`
- Test: `apps/api/tests/managed-agents-signal-tools.test.ts`

`listDealsForOrg` mirrors `fetchPortfolioNode` (`signalMonitor/index.ts:49-72`); `createSignalNotification` mirrors the per-signal `Activity` insert in `routeSignalsNode` (`signalMonitor/index.ts:163-174`). Behavior parity only — the existing unused `notifications` array in `routeSignalsNode` is a separate latent gap, out of scope for this migration.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-signal-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('listDealsForOrg', () => {
  it('queries active deals scoped to the organization, excluding passed/closed-lost', async () => {
    let capturedFilters: any[] = [];
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Deal') throw new Error(`Unexpected table: ${table}`);
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          capturedFilters.push(['eq', col, val]);
          return builder;
        },
        neq: (col: string, val: any) => {
          capturedFilters.push(['neq', col, val]);
          return builder;
        },
        order: () => builder,
        limit: async () => ({
          data: [{ id: 'deal-1', name: 'Acme', industry: 'SaaS', stage: 'DILIGENCE', revenue: 5, Company: { name: 'Acme Co' } }],
          error: null,
        }),
      };
      return builder;
    });

    const { listDealsForOrg } = await import('../src/services/managedAgents/tools/listDealsForOrg.js');
    const result = await listDealsForOrg('org-1', {});

    expect(capturedFilters).toContainEqual(['eq', 'organizationId', 'org-1']);
    expect(capturedFilters).toContainEqual(['neq', 'status', 'PASSED']);
    expect(capturedFilters).toContainEqual(['neq', 'stage', 'CLOSED_LOST']);
    expect(result).toEqual({
      deals: [{ id: 'deal-1', name: 'Acme', industry: 'SaaS', stage: 'DILIGENCE', revenue: 5, company: 'Acme Co' }],
    });
  });
});

describe('createSignalNotification', () => {
  it('inserts an Activity row for the flagged deal', async () => {
    let inserted: any = null;
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Activity') throw new Error(`Unexpected table: ${table}`);
      return {
        insert: async (payload: any) => {
          inserted = payload;
          return { error: null };
        },
      };
    });

    const { createSignalNotification } = await import('../src/services/managedAgents/tools/createSignalNotification.js');
    const result = await createSignalNotification('org-1', {
      dealId: 'deal-1',
      signalType: 'leadership_change',
      severity: 'critical',
      title: 'CEO departure',
      description: 'The CEO resigned last week.',
      suggestedAction: 'Reach out to the board.',
    });

    expect(result).toEqual({ created: true });
    expect(inserted).toMatchObject({
      dealId: 'deal-1',
      type: 'AI_SIGNAL',
      title: '[CRITICAL] CEO departure',
      description: 'The CEO resigned last week.. Suggested action: Reach out to the board.',
    });
  });

  it('returns created: false when dealId is missing', async () => {
    const { createSignalNotification } = await import('../src/services/managedAgents/tools/createSignalNotification.js');
    const result = await createSignalNotification('org-1', {
      dealId: '',
      signalType: 'leadership_change',
      severity: 'critical',
      title: 't',
      description: 'd',
      suggestedAction: 'a',
    });
    expect(result).toEqual({ created: false });
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-signal-tools.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write `listDealsForOrg.ts`**

```ts
// apps/api/src/services/managedAgents/tools/listDealsForOrg.ts
import { supabase } from '../../../supabase.js';

export interface ListedDeal {
  id: string;
  name: string;
  industry: string | null;
  stage: string;
  revenue: number | null;
  company: string | null;
}

export async function listDealsForOrg(organizationId: string, _input: unknown): Promise<{ deals: ListedDeal[] }> {
  const { data, error } = await supabase
    .from('Deal')
    .select('id, name, industry, stage, revenue, Company(name)')
    .eq('organizationId', organizationId)
    .neq('status', 'PASSED')
    .neq('stage', 'CLOSED_LOST')
    .order('updatedAt', { ascending: false })
    .limit(30);

  if (error || !data) return { deals: [] };

  return {
    deals: data.map((d: any) => ({
      id: d.id,
      name: d.name,
      industry: d.industry ?? null,
      stage: d.stage,
      revenue: d.revenue ?? null,
      company: d.Company?.name ?? null,
    })),
  };
}
```

- [ ] **Step 4: Write `createSignalNotification.ts`**

```ts
// apps/api/src/services/managedAgents/tools/createSignalNotification.ts
import { supabase } from '../../../supabase.js';
import { log } from '../../../utils/logger.js';

interface CreateSignalNotificationInput {
  dealId: string;
  signalType: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  suggestedAction: string;
}

export async function createSignalNotification(
  _organizationId: string,
  input: CreateSignalNotificationInput,
): Promise<{ created: boolean }> {
  if (!input.dealId || (input.severity !== 'critical' && input.severity !== 'warning')) {
    return { created: false };
  }

  const { error } = await supabase.from('Activity').insert({
    dealId: input.dealId,
    type: 'AI_SIGNAL',
    title: `[${input.severity.toUpperCase()}] ${input.title}`,
    description: `${input.description}. Suggested action: ${input.suggestedAction}`,
  });

  if (error) {
    log.error('create_signal_notification: failed to persist', { dealId: input.dealId, error: error.message });
    return { created: false };
  }
  return { created: true };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-signal-tools.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/managedAgents/tools/listDealsForOrg.ts apps/api/src/services/managedAgents/tools/createSignalNotification.ts apps/api/tests/managed-agents-signal-tools.test.ts
git commit -m "feat(managed-agents): list_deals_for_org and create_signal_notification custom tools"
```

---

### Task 5: Per-org research concurrency lock

**Files:**
- Create: `apps/api/src/services/managedAgents/researchLock.ts`
- Test: `apps/api/tests/managed-agents-research-lock.test.ts`

Two-step compare-and-swap over `Organization.researchLockedAt` (added in Task 1): try the "currently null" branch, then the "stale" branch — `supabase-js`'s query builder can't express `NULL OR < threshold` in one call.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-research-lock.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));

async function getLock() {
  return await import('../src/services/managedAgents/researchLock.js');
}

beforeEach(() => {
  mockSupabase.from.mockReset();
});

describe('acquireResearchLock', () => {
  it('acquires the lock when researchLockedAt is null', async () => {
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({
            select: async () => ({ data: [{ id: 'org-1' }], error: null }),
          }),
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(acquired).toBe(true);
  });

  it('falls back to the stale-lock branch when the null branch matches nothing', async () => {
    let staleAttempted = false;
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({
            select: async () => ({ data: [], error: null }),
          }),
          lt: () => {
            staleAttempted = true;
            return { select: async () => ({ data: [{ id: 'org-1' }], error: null }) };
          },
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(staleAttempted).toBe(true);
    expect(acquired).toBe(true);
  });

  it('returns false when neither branch matches (a fresh lock is already held)', async () => {
    mockSupabase.from.mockImplementation(() => ({
      update: () => ({
        eq: () => ({
          is: () => ({ select: async () => ({ data: [], error: null }) }),
          lt: () => ({ select: async () => ({ data: [], error: null }) }),
        }),
      }),
    }));

    const { acquireResearchLock } = await getLock();
    const acquired = await acquireResearchLock('org-1');
    expect(acquired).toBe(false);
  });
});

describe('releaseResearchLock', () => {
  it('clears researchLockedAt', async () => {
    let updated: any = null;
    mockSupabase.from.mockImplementation(() => ({
      update: (payload: any) => {
        updated = payload;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { releaseResearchLock } = await getLock();
    await releaseResearchLock('org-1');
    expect(updated).toEqual({ researchLockedAt: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-research-lock.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/managedAgents/researchLock.ts
import { supabase } from '../../supabase.js';

const STALE_LOCK_MS = 10 * 60 * 1000;

export async function acquireResearchLock(organizationId: string): Promise<boolean> {
  const now = new Date().toISOString();

  const freshAttempt = await supabase
    .from('Organization')
    .update({ researchLockedAt: now })
    .eq('id', organizationId)
    .is('researchLockedAt', null)
    .select();
  if (freshAttempt.data && freshAttempt.data.length > 0) return true;

  const staleThreshold = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  const staleAttempt = await supabase
    .from('Organization')
    .update({ researchLockedAt: now })
    .eq('id', organizationId)
    .lt('researchLockedAt', staleThreshold)
    .select();

  return Boolean(staleAttempt.data && staleAttempt.data.length > 0);
}

export async function releaseResearchLock(organizationId: string): Promise<void> {
  await supabase.from('Organization').update({ researchLockedAt: null }).eq('id', organizationId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-research-lock.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/managedAgents/researchLock.ts apps/api/tests/managed-agents-research-lock.test.ts
git commit -m "feat(managed-agents): per-org research concurrency lock"
```

---

### Task 6: Firm Research orchestrator + `enrich-firm` route wiring

**Files:**
- Create: `apps/api/src/services/managedAgents/firmResearchOrchestrator.ts`
- Create: `apps/api/src/services/usage/trackedManagedAgentSession.ts`
- Modify: `apps/api/src/routes/onboarding.ts:1-16` (imports), `:285-377` (`enrich-firm` handler), `:379-427` (`research-status` handler)
- Test: `apps/api/tests/managed-agents-firm-research-orchestrator.test.ts`

`trackedManagedAgentSession` mirrors `trackedApifyCall` (`apps/api/src/services/usage/trackedApify.ts`) — times the session, records a `UsageEvent` with `provider: 'anthropic'` (already a valid value in the existing CHECK constraint — no new migration needed) using the LLM-shaped fields since Managed Agents sessions report real token usage.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-firm-research-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const createSessionAndDrain = vi.fn();
vi.mock('../src/services/managedAgents/session.js', () => ({ createSessionAndDrain }));

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

const acquireResearchLock = vi.fn();
const releaseResearchLock = vi.fn();
vi.mock('../src/services/managedAgents/researchLock.js', () => ({ acquireResearchLock, releaseResearchLock }));

vi.mock('../src/services/managedAgents/config.js', () => ({
  FIRM_RESEARCH_AGENT_ID: 'agent_firm',
  MANAGED_AGENTS_ENVIRONMENT_ID: 'env_1',
}));

async function getOrchestrator() {
  return await import('../src/services/managedAgents/firmResearchOrchestrator.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
  mockSupabase.from.mockImplementation(() => ({
    update: () => ({ eq: async () => ({ error: null }) }),
  }));
});

describe('runFirmResearchViaManagedAgents', () => {
  it('skips the run and releases nothing when the lock cannot be acquired', async () => {
    acquireResearchLock.mockResolvedValue(false);
    const { runFirmResearchViaManagedAgents } = await getOrchestrator();

    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(createSessionAndDrain).not.toHaveBeenCalled();
    expect(releaseResearchLock).not.toHaveBeenCalled();
  });

  it('runs the session, records usage, and releases the lock on success', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockResolvedValue({ status: 'completed', usage: { inputTokens: 500, outputTokens: 100 } });

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(createSessionAndDrain).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_firm', environmentId: 'env_1', organizationId: 'org-1' }),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ operation: 'firm_research_managed_agent', provider: 'anthropic', promptTokens: 500, completionTokens: 100 });
    expect(releaseResearchLock).toHaveBeenCalledWith('org-1');
  });

  it('marks researchStatus failed and releases the lock when the session fails', async () => {
    acquireResearchLock.mockResolvedValue(true);
    createSessionAndDrain.mockResolvedValue({ status: 'failed', error: 'boom', usage: { inputTokens: 0, outputTokens: 0 } });
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation(() => ({
      update: (payload: any) => {
        updatedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));

    const { runFirmResearchViaManagedAgents } = await getOrchestrator();
    await runFirmResearchViaManagedAgents({
      organizationId: 'org-1',
      firmName: 'Acme Capital',
      websiteUrl: 'https://acme.example',
      linkedinUrl: '',
    });

    expect(updatedSettings).toMatchObject({ researchStatus: 'failed' });
    expect(releaseResearchLock).toHaveBeenCalledWith('org-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-firm-research-orchestrator.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Write `trackedManagedAgentSession.ts`**

```ts
// apps/api/src/services/usage/trackedManagedAgentSession.ts
import { recordUsageEvent } from './trackedLLM.js';

const MANAGED_AGENT_MODEL = process.env.AI_AGENT_MODEL || 'claude-sonnet-5';

export async function recordManagedAgentSessionUsage(params: {
  operation: string;
  status: 'success' | 'error';
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}): Promise<void> {
  await recordUsageEvent({
    operation: params.operation,
    provider: 'anthropic',
    model: MANAGED_AGENT_MODEL,
    promptTokens: params.usage.inputTokens,
    completionTokens: params.usage.outputTokens,
    status: params.status,
    durationMs: params.durationMs,
  });
}
```

- [ ] **Step 4: Write the orchestrator**

```ts
// apps/api/src/services/managedAgents/firmResearchOrchestrator.ts
import { supabase } from '../../supabase.js';
import { log } from '../../utils/logger.js';
import { captureAgentError } from '../../utils/sentryHelpers.js';
import { createSessionAndDrain } from './session.js';
import { acquireResearchLock, releaseResearchLock } from './researchLock.js';
import { recordManagedAgentSessionUsage } from '../usage/trackedManagedAgentSession.js';
import { saveFirmProfile } from './tools/saveFirmProfile.js';
import { FIRM_RESEARCH_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID } from './config.js';

export interface RunFirmResearchInput {
  organizationId: string;
  firmName: string;
  websiteUrl: string;
  linkedinUrl: string;
}

export async function runFirmResearchViaManagedAgents(input: RunFirmResearchInput): Promise<void> {
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
    });

    if (result.status === 'failed') {
      await markResearchFailed(input.organizationId, result.error || 'unknown error');
    }
  } catch (err) {
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
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-firm-research-orchestrator.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Wire the flag into `onboarding.ts`**

Add the import (near the existing imports, `onboarding.ts:1-16`):

```ts
import { runFirmResearchViaManagedAgents } from '../services/managedAgents/firmResearchOrchestrator.js';
```

Replace the fire-and-forget block inside the `enrich-firm` handler (`onboarding.ts:350-372`, keeping everything before it — the Phase-1 `runFirmResearch` fast pass and rate-limit check — unchanged):

```ts
    // Fire deep research in background (not awaited). RESEARCH_ENGINE picks
    // the legacy LangGraph deep pass or the Managed Agents flow; either way
    // this never blocks the HTTP response.
    if (result.success && result.firmProfile && (websiteUrl || linkedinUrl)) {
      if (process.env.RESEARCH_ENGINE === 'managed-agents') {
        void runFirmResearchViaManagedAgents({
          organizationId: orgId,
          firmName,
          websiteUrl: websiteUrl || '',
          linkedinUrl: linkedinUrl || '',
        }).catch((err) => {
          log.error('Managed Agents firm research failed', { error: err.message });
          captureAgentError(err, { context: 'runFirmResearchViaManagedAgents:background' });
        });
      } else {
        void runWithUsageContext(
          { userId, organizationId: orgId, source: 'background' },
          async () => {
            await runDeepResearch({
              phase1Profile: result.firmProfile!,
              phase1PersonProfile: result.personProfile,
              websiteUrl: websiteUrl || '',
              linkedinUrl: linkedinUrl || '',
              firmName,
              userId,
              organizationId: orgId,
            }).catch(err => {
              log.error('Deep research background task failed', { error: err.message });
              captureAgentError(err, { context: 'runDeepResearch:background' });
            });
          },
        );
      }
    }
```

- [ ] **Step 7: Make `research-status` read `researchStatus` when the Managed Agents engine wrote it**

The existing handler (`onboarding.ts:381-427`) reads `settings.deepResearch` via `markStaleDeepResearchAsFailed`, which only exists on the legacy path. Add a check for the Managed Agents shape before that call:

```ts
    const settings = (org?.settings || {}) as Record<string, any>;

    if (process.env.RESEARCH_ENGINE === 'managed-agents') {
      if (!settings.researchStatus) {
        return res.json({ phase: 1, status: 'complete', newInsightsCount: 0 });
      }
      return res.json({
        phase: 2,
        status: settings.researchStatus,
        newInsightsCount: 0,
        error: settings.researchStatus === 'failed' ? settings.researchError : undefined,
      });
    }

    // Self-heal stale 'running' rows: if the background task was killed
```

(the comment above marks where the existing legacy code — `const deepResearch = await markStaleDeepResearchAsFailed(...)` onward — continues unchanged).

- [ ] **Step 8: Run the full onboarding test suite**

```bash
cd apps/api && npx vitest run tests/managed-agents-firm-research-orchestrator.test.ts
grep -rl "onboarding" apps/api/tests --include="*.test.ts" | xargs -I{} npx vitest run {}
```

Expected: all PASS — confirms the flag-off path (legacy) is untouched.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/managedAgents/firmResearchOrchestrator.ts apps/api/src/services/usage/trackedManagedAgentSession.ts apps/api/src/routes/onboarding.ts apps/api/tests/managed-agents-firm-research-orchestrator.test.ts
git commit -m "feat(managed-agents): firm research orchestrator wired behind RESEARCH_ENGINE flag"
```

---

### Task 7: Signal Monitor orchestrator + `scan-signals` route wiring

**Files:**
- Create: `apps/api/src/services/managedAgents/signalMonitorOrchestrator.ts`
- Modify: `apps/api/src/routes/ai-agents.ts:109-121`
- Test: `apps/api/tests/managed-agents-signal-monitor-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-signal-monitor-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createSessionAndDrain = vi.fn();
vi.mock('../src/services/managedAgents/session.js', () => ({ createSessionAndDrain }));

const recorded: any[] = [];
vi.mock('../src/services/usage/trackedLLM.js', () => ({
  recordUsageEvent: vi.fn(async (e: any) => {
    recorded.push(e);
  }),
}));

vi.mock('../src/services/managedAgents/config.js', () => ({
  SIGNAL_MONITOR_AGENT_ID: 'agent_signal',
  MANAGED_AGENTS_ENVIRONMENT_ID: 'env_1',
}));

beforeEach(() => {
  vi.clearAllMocks();
  recorded.length = 0;
});

describe('runSignalMonitorViaManagedAgents', () => {
  it('creates a session for the org and returns completed on success', async () => {
    createSessionAndDrain.mockResolvedValue({ status: 'completed', usage: { inputTokens: 200, outputTokens: 40 } });
    const { runSignalMonitorViaManagedAgents } = await import('../src/services/managedAgents/signalMonitorOrchestrator.js');

    const result = await runSignalMonitorViaManagedAgents('org-1');

    expect(createSessionAndDrain).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_signal', environmentId: 'env_1', organizationId: 'org-1' }),
    );
    expect(result).toEqual({ status: 'completed' });
    expect(recorded[0]).toMatchObject({ operation: 'signal_monitor_managed_agent', promptTokens: 200, completionTokens: 40 });
  });

  it('returns failed when the session fails', async () => {
    createSessionAndDrain.mockResolvedValue({ status: 'failed', error: 'boom', usage: { inputTokens: 0, outputTokens: 0 } });
    const { runSignalMonitorViaManagedAgents } = await import('../src/services/managedAgents/signalMonitorOrchestrator.js');

    const result = await runSignalMonitorViaManagedAgents('org-1');
    expect(result).toEqual({ status: 'failed', error: 'boom' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-signal-monitor-orchestrator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/services/managedAgents/signalMonitorOrchestrator.ts
import { createSessionAndDrain } from './session.js';
import { recordManagedAgentSessionUsage } from '../usage/trackedManagedAgentSession.js';
import { listDealsForOrg } from './tools/listDealsForOrg.js';
import { createSignalNotification } from './tools/createSignalNotification.js';
import { SIGNAL_MONITOR_AGENT_ID, MANAGED_AGENTS_ENVIRONMENT_ID } from './config.js';

export interface SignalMonitorRunResult {
  status: 'completed' | 'failed';
  error?: string;
}

export async function runSignalMonitorViaManagedAgents(organizationId: string): Promise<SignalMonitorRunResult> {
  const start = Date.now();
  const result = await createSessionAndDrain({
    agentId: SIGNAL_MONITOR_AGENT_ID,
    environmentId: MANAGED_AGENTS_ENVIRONMENT_ID,
    organizationId,
    initialMessage: 'Scan this organization\'s active deals for signals.',
    toolHandlers: {
      list_deals_for_org: listDealsForOrg,
      create_signal_notification: createSignalNotification,
    },
  });

  await recordManagedAgentSessionUsage({
    operation: 'signal_monitor_managed_agent',
    status: result.status === 'completed' ? 'success' : 'error',
    usage: result.usage,
    durationMs: Date.now() - start,
  });

  return result.status === 'completed' ? { status: 'completed' } : { status: 'failed', error: result.error };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-signal-monitor-orchestrator.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Wire the flag into `ai-agents.ts`**

Replace the `scan-signals` handler (`ai-agents.ts:109-121`):

```ts
// POST /api/ai/scan-signals - Scan portfolio for deal signals
router.post('/ai/scan-signals', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    log.info('Scanning deal signals', { orgId });
    const result =
      process.env.SIGNAL_ENGINE === 'managed-agents'
        ? await runSignalMonitorViaManagedAgents(orgId)
        : await runSignalMonitor(orgId);
    res.json(result);
  } catch (error: any) {
    log.error('Signal scan error', error);
    const { statusCode, userMessage } = classifyAIErrorObject(error);
    res.status(statusCode).json({ error: userMessage });
  }
});
```

Add the import near the existing `runSignalMonitor` import:

```ts
import { runSignalMonitorViaManagedAgents } from '../services/managedAgents/signalMonitorOrchestrator.js';
```

- [ ] **Step 6: Run the ai-agents route tests**

```bash
grep -rl "ai-agents\|scan-signals" apps/api/tests --include="*.test.ts" | xargs -I{} npx vitest run {}
```

Expected: PASS — legacy (flag-off) path unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/managedAgents/signalMonitorOrchestrator.ts apps/api/src/routes/ai-agents.ts apps/api/tests/managed-agents-signal-monitor-orchestrator.test.ts
git commit -m "feat(managed-agents): signal monitor orchestrator wired behind SIGNAL_ENGINE flag"
```

---

### Task 8: Managed Agents webhook receiver

**Files:**
- Create: `apps/api/src/routes/managed-agents-webhooks.ts`
- Modify: `apps/api/src/app.ts` (mount before `express.json()`)
- Test: `apps/api/tests/managed-agents-webhooks.test.ts`

The nightly-cron path (Task 9) awaits `createSessionAndDrain` directly, so it doesn't need this. This handler exists for the *un*awaited firm-research background session: if the process that started it dies before the drain loop's own failure handling runs, this is the structural backstop that still marks `researchStatus: 'failed'` — replacing today's 5-minute staleness-timeout guess with an actual signal.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-webhooks.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const unwrap = vi.fn();
const retrieve = vi.fn();
vi.mock('../src/services/ai/client.js', () => ({
  getAnthropicClient: () => ({
    beta: { webhooks: { unwrap }, sessions: { retrieve } },
  }),
}));

async function buildApp() {
  const { default: router } = await import('../src/routes/managed-agents-webhooks.js');
  const app = express();
  app.use('/api/webhooks/managed-agents', express.raw({ type: 'application/json' }), router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/managed-agents', () => {
  it('rejects a payload with an invalid signature', async () => {
    unwrap.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const app = await buildApp();

    const res = await request(app).post('/').send(Buffer.from('{}'));
    expect(res.status).toBe(400);
  });

  it('marks researchStatus failed on session.status_terminated with an errored session', async () => {
    unwrap.mockReturnValue({ data: { type: 'session.status_terminated', id: 'sesn_1' } });
    retrieve.mockResolvedValue({
      id: 'sesn_1',
      status: 'terminated',
      metadata: { organizationId: 'org-1' },
      error: { message: 'sandbox crashed' },
    });
    let updatedSettings: any = null;
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { settings: { researchStatus: 'running' } }, error: null }) }) }),
      update: (payload: any) => {
        updatedSettings = payload.settings;
        return { eq: async () => ({ error: null }) };
      },
    }));
    const app = await buildApp();

    const res = await request(app).post('/').send(Buffer.from('{}'));
    expect(res.status).toBe(204);
    expect(updatedSettings).toMatchObject({ researchStatus: 'failed', researchError: 'sandbox crashed' });
  });

  it('ignores event types it does not handle', async () => {
    unwrap.mockReturnValue({ data: { type: 'agent.updated', id: 'agent_1' } });
    const app = await buildApp();

    const res = await request(app).post('/').send(Buffer.from('{}'));
    expect(res.status).toBe(204);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-webhooks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/managed-agents-webhooks.ts
import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getAnthropicClient } from '../services/ai/client.js';

const router = Router();

// Mounted with express.raw() ahead of the app's global express.json() —
// webhook signature verification needs the exact request bytes, and
// re-serializing through a JSON parser first would break the HMAC check.
router.post('/', async (req: Request, res: Response) => {
  const client = getAnthropicClient();
  let event;
  try {
    event = client.beta.webhooks.unwrap(req.body, { headers: req.headers as Record<string, string> });
  } catch (err) {
    log.warn('Managed Agents webhook: signature verification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(400).json({ error: 'invalid signature' });
  }

  if (event.data.type !== 'session.status_terminated') {
    return res.status(204).end();
  }

  try {
    const session = await client.beta.sessions.retrieve(event.data.id);
    const organizationId = (session as any).metadata?.organizationId;
    const sessionError = (session as any).error;
    if (organizationId && sessionError) {
      const { data: org } = await supabase.from('Organization').select('settings').eq('id', organizationId).single();
      const settings = (org?.settings || {}) as Record<string, any>;
      settings.researchStatus = 'failed';
      settings.researchError = sessionError.message || 'Managed Agents session terminated with an error';
      await supabase.from('Organization').update({ settings }).eq('id', organizationId);
    }
  } catch (err) {
    log.error('Managed Agents webhook: failed to process session.status_terminated', {
      sessionId: event.data.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  res.status(204).end();
});

export default router;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-webhooks.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Mount the route in `app.ts` ahead of `express.json()`**

Insert before the existing `app.use(express.json({ limit: '50mb' }));` (`app.ts:194`):

```ts
import managedAgentsWebhooksRouter from './routes/managed-agents-webhooks.js';
// ...
app.use('/api/webhooks/managed-agents', express.raw({ type: 'application/json' }), managedAgentsWebhooksRouter);
app.use(express.json({ limit: '50mb' }));
```

- [ ] **Step 6: Run the full app test suite to confirm no route-ordering regressions**

```bash
cd apps/api && npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/managed-agents-webhooks.ts apps/api/src/app.ts apps/api/tests/managed-agents-webhooks.test.ts
git commit -m "feat(managed-agents): webhook receiver marks failed firm research on session.status_terminated"
```

---

### Task 9: Nightly Vercel Cron fan-out for Signal Monitor

**Files:**
- Create: `apps/api/src/routes/cron-signal-scan.ts`
- Modify: `apps/api/src/app.ts` (mount route)
- Modify: `vercel.json` (add `crons`)
- Modify: `apps/api/.env.example`
- Test: `apps/api/tests/managed-agents-cron-signal-scan.test.ts`

Staged in batches of 5 concurrent sessions — comfortably inside the 300 RPM session-create limit even at hundreds of orgs, and it bounds how many sessions can be mid-flight if the org list is large. Authenticated via a `CRON_SECRET` bearer header (Vercel Cron's own recommended pattern — there's no existing precedent for a system-triggered route in this repo to follow).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/managed-agents-cron-signal-scan.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSupabase = { from: vi.fn() };
vi.mock('../src/supabase.js', () => ({ supabase: mockSupabase }));
vi.mock('../src/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/utils/sentryHelpers.js', () => ({ captureAgentError: vi.fn() }));

const runSignalMonitorViaManagedAgents = vi.fn();
vi.mock('../src/services/managedAgents/signalMonitorOrchestrator.js', () => ({ runSignalMonitorViaManagedAgents }));

async function buildApp() {
  const { default: router } = await import('../src/routes/cron-signal-scan.js');
  const app = express();
  app.use(express.json());
  app.use('/api/cron/signal-scan', router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});

describe('POST /api/cron/signal-scan', () => {
  it('rejects requests without a valid bearer token', async () => {
    const app = await buildApp();
    const res = await request(app).post('/').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('fans out to every active org and returns a summary', async () => {
    mockSupabase.from.mockImplementation((table: string) => {
      if (table !== 'Organization') throw new Error(`Unexpected table: ${table}`);
      return { select: () => ({ eq: async () => ({ data: [{ id: 'org-1' }, { id: 'org-2' }], error: null }) }) };
    });
    runSignalMonitorViaManagedAgents.mockResolvedValue({ status: 'completed' });

    const app = await buildApp();
    const res = await request(app).post('/').set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledTimes(2);
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledWith('org-1');
    expect(runSignalMonitorViaManagedAgents).toHaveBeenCalledWith('org-2');
    expect(res.body).toEqual({ scanned: 2, failed: 0 });
  });

  it('continues past a single org failure and reports it in the summary', async () => {
    mockSupabase.from.mockImplementation(() => ({
      select: () => ({ eq: async () => ({ data: [{ id: 'org-1' }, { id: 'org-2' }], error: null }) }),
    }));
    runSignalMonitorViaManagedAgents.mockImplementation(async (orgId: string) =>
      orgId === 'org-1' ? { status: 'failed', error: 'boom' } : { status: 'completed' },
    );

    const app = await buildApp();
    const res = await request(app).post('/').set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 2, failed: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && npx vitest run tests/managed-agents-cron-signal-scan.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/routes/cron-signal-scan.ts
import { Router, Request, Response } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { captureAgentError } from '../utils/sentryHelpers.js';
import { runSignalMonitorViaManagedAgents } from '../services/managedAgents/signalMonitorOrchestrator.js';

const router = Router();
const BATCH_SIZE = 5;

router.post('/', async (req: Request, res: Response) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: orgs, error } = await supabase.from('Organization').select('id').eq('isActive', true);
  if (error || !orgs) {
    log.error('Nightly signal scan: failed to list orgs', { error: error?.message });
    return res.status(500).json({ error: 'Failed to list organizations' });
  }

  let failed = 0;
  for (let i = 0; i < orgs.length; i += BATCH_SIZE) {
    const batch = orgs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((org) =>
        runSignalMonitorViaManagedAgents(org.id).catch((err) => {
          captureAgentError(err, { context: 'cron-signal-scan', organizationId: org.id });
          return { status: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
        }),
      ),
    );
    failed += results.filter((r) => r.status === 'failed').length;
  }

  log.info('Nightly signal scan complete', { scanned: orgs.length, failed });
  res.json({ scanned: orgs.length, failed });
});

export default router;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && npx vitest run tests/managed-agents-cron-signal-scan.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Mount the route in `app.ts`**

```ts
import cronSignalScanRouter from './routes/cron-signal-scan.js';
// ...
app.use('/api/cron/signal-scan', cronSignalScanRouter);
```

(Placed with the other route mounts, after `express.json()` — this route reads a JSON-free body, but keeping it alongside the other authenticated routes rather than the raw-body webhook route keeps auth conventions grouped.)

- [ ] **Step 6: Add the cron schedule to `vercel.json`**

```json
{
  "version": 2,
  "installCommand": "rm -f package-lock.json && npm install --include=dev",
  "buildCommand": "npm run build:api && npm run build --workspace=@ai-crm/web-next",
  "outputDirectory": "apps/web-next/.next",
  "functions": {
    "apps/web-next/src/app/api/[...slug]/route.ts": {
      "memory": 1769,
      "maxDuration": 300
    }
  },
  "crons": [
    {
      "path": "/api/cron/signal-scan",
      "schedule": "0 6 * * *"
    }
  ]
}
```

(`0 6 * * *` runs nightly at 06:00 UTC — Vercel Cron requests carry no custom headers, so `CRON_SECRET` must be sent by Vercel's own cron invoker, which authenticates via the platform, not this header; confirm the exact auth mechanism Vercel provides for cron requests before flipping `SIGNAL_ENGINE` in production — see rollout notes below.)

- [ ] **Step 7: Document the new env vars**

Append to `apps/api/.env.example`:

```
# Phase 2-B: Research & Signals on Managed Agents (see docs/superpowers/specs/2026-08-04-research-signals-managed-agents-design.md)
RESEARCH_ENGINE=legacy          # legacy | managed-agents
SIGNAL_ENGINE=legacy            # legacy | managed-agents
MANAGED_AGENTS_ENVIRONMENT_ID=
MANAGED_AGENTS_FIRM_RESEARCH_AGENT_ID=
MANAGED_AGENTS_SIGNAL_MONITOR_AGENT_ID=
AI_AGENT_MODEL=claude-sonnet-5
CRON_SECRET=
ANTHROPIC_WEBHOOK_SIGNING_KEY=
```

- [ ] **Step 8: Run the full suite**

```bash
cd apps/api && npm test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/cron-signal-scan.ts apps/api/src/app.ts vercel.json apps/api/.env.example apps/api/tests/managed-agents-cron-signal-scan.test.ts
git commit -m "feat(managed-agents): nightly Vercel Cron fan-out for signal monitoring"
```

---

## Rollout (not a coding task — operator checklist, mirrors `docs/PHASE1-ROLLOUT-CHECKLIST.md`)

1. Run `apps/api/managed-agents-migration.sql` manually in the Supabase SQL editor (Vercel never runs SQL — see [[project_supabase_migrations]]).
2. Run `apps/api/managed-agents/setup.sh` once; set the three `MANAGED_AGENTS_*_ID` env vars in Vercel.
3. Register the webhook endpoint in the Anthropic Console (Manage → Webhooks) pointing at `/api/webhooks/managed-agents`, subscribed to `session.status_terminated`; set `ANTHROPIC_WEBHOOK_SIGNING_KEY` in Vercel.
4. Confirm the Anthropic org has Managed Agents access (beta feature) before flipping either flag anywhere.
5. **Before relying on the nightly cron in production**, confirm how Vercel Cron requests should actually be authenticated on this plan/deployment — the `CRON_SECRET` bearer check in Task 9 is a placeholder for whatever Vercel's current recommended mechanism is (a signed header it adds automatically, or a manually-set secret you compare against `req.headers['authorization']`); check Vercel's current docs and adjust `cron-signal-scan.ts`'s auth check if the mechanism differs.
6. Flip `RESEARCH_ENGINE=managed-agents` for a small controlled test (one org), confirm `Organization.settings.firmProfile` populates progressively and `researchStatus` reaches `completed`.
7. Flip `SIGNAL_ENGINE=managed-agents`, manually `POST /api/ai/scan-signals` for a test org, confirm `Activity` rows land with `type: 'AI_SIGNAL'`.
8. Soak each flag independently for two weeks before deleting legacy code (`deepResearch*.ts`, `firmResearchAgent/graph.ts` + `nodes/`, `signalMonitor/index.ts`, the Apify paths in `webSearch.ts` — confirm `scrapeLinkedInProfile` has no other callers before removing it).

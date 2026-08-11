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

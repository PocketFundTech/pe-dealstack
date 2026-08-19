# Avise — Documentation

> The complete docs tree. Last updated 2026-04-29 against the live codebase.

## Start here

- **[New Teammate Guide](./onboarding/new-teammate-guide.md)** — read this on day one.
- **[Architecture Overview](./architecture/overview.md)** — the whole system in one page.

## Architecture

| Doc | What it covers |
| --- | --- |
| [Overview](./architecture/overview.md) | Top-down picture, repo layout, both frontends, the API, multi-tenancy, AI layer, deployment |
| [Data Model](./architecture/data-model.md) | Every table; constraints; gotchas |
| [API Routes](./architecture/api-routes.md) | All 48 route files mapped |
| [AI Agents](./architecture/ai-agents.md) | The eight agents in detail |
| [Security](./architecture/security.md) | Auth, RBAC, multi-tenancy, rate limits, secrets |

## User flows

End-to-end flows with sequence diagrams.

| Flow | What happens |
| --- | --- |
| [Signup & Onboarding](./user-flows/signup-and-onboarding.md) | New user → first deal in pipeline with extracted financials |
| [Team Invitation](./user-flows/team-invitation.md) | Admin invites; teammate accepts |
| [Deal Import](./user-flows/deal-import.md) | Bulk CSV / Excel / paste |
| [Deal Ingest](./user-flows/deal-ingest.md) | Single-deal CIM upload |
| [Financial Extraction](./user-flows/financial-extraction.md) | Document → FinancialStatement rows |
| [Deal Chat](./user-flows/deal-chat.md) | ReAct agent on deal page |
| [VDR & Document Management](./user-flows/vdr-document-management.md) | Folders, uploads, requests |
| [Memo Builder](./user-flows/memo-builder.md) | AI-authored IC memos |
| [Contacts CRM](./user-flows/contacts-crm.md) | Contact CRUD, scoring, CSV |
| [Admin Command Center](./user-flows/admin-command-center.md) | Admin dashboard + RBAC |

## Features

Per-feature documentation. See [features index](./features/README.md). Highlights:

- [Deal Pipeline](./features/deal-pipeline.md), [Deal Detail](./features/deal-detail.md), [Deal Chat](./features/deal-chat.md), [Deal Import](./features/deal-import.md), [Deal Intake](./features/deal-intake.md)
- [VDR](./features/vdr.md), [Document Management](./features/document-management.md), [Folder Insights](./features/folder-insights.md)
- [Financial Extraction](./features/financial-extraction.md), [Financial Analysis](./features/financial-analysis.md), [Multi-Document Merge](./features/financial-merge.md)
- [Memo Builder](./features/memo-builder.md), [Templates](./features/templates.md)
- [Firm Research Agent](./features/firm-research.md), [Meeting Prep](./features/meeting-prep.md), [Email Drafter](./features/email-drafter.md), [Signal Monitor](./features/signal-monitor.md), [Contact Enrichment](./features/contact-enrichment.md)
- [Contacts CRM](./features/contacts-crm.md), [Activities](./features/activities.md)
- [Onboarding](./features/onboarding.md), [Dashboard](./features/dashboard.md), [Tasks](./features/tasks.md), [Notifications](./features/notifications.md), [Settings](./features/settings.md)
- [Invitations & Team](./features/invitations-and-team.md), [Admin & RBAC](./features/admin-and-rbac.md), [Audit Log](./features/audit-log.md)
- [Help & Support](./features/help-and-support.md)

## Diagrams

All architecture and flow diagrams are in [`diagrams/`](./diagrams/). Each is a `.mmd` (Mermaid source) plus a rendered `.png`. Render with `npx -p @mermaid-js/mermaid-cli mmdc -i file.mmd -o file.png` or any Mermaid editor.

| File | What it shows |
| --- | --- |
| [02-deal-lifecycle](./diagrams/02-deal-lifecycle.mmd) | 7 stages + entry sources |
| [03-document-vdr-flow](./diagrams/03-document-vdr-flow.mmd) | VDR upload + folder insights |
| [04-memo-builder-flow](./diagrams/04-memo-builder-flow.mmd) | Memo generation pipeline |
| [05-user-journey-admin](./diagrams/05-user-journey-admin.mmd) | Admin journey |
| [06-user-journey-analyst](./diagrams/06-user-journey-analyst.mmd) | Analyst journey |
| [07-er-diagram](./diagrams/07-er-diagram.mmd) | Full ER model |
| [08-system-architecture](./diagrams/08-system-architecture.mmd) | Full stack picture (updated) |
| [09-role-access-matrix](./diagrams/09-role-access-matrix.mmd) | RBAC matrix |
| [10-navigation-page-flow](./diagrams/10-navigation-page-flow.mmd) | Page nav graph |
| [11-financial-extraction-pipeline](./diagrams/11-financial-extraction-pipeline.mmd) | 6-node Financial Agent (updated) |
| [12-ai-agents-architecture](./diagrams/12-ai-agents-architecture.mmd) | All 8 agents (updated) |
| [13-multi-tenancy-org-isolation](./diagrams/13-multi-tenancy-org-isolation.mmd) | Org isolation (updated) |
| [14-onboarding-flow](./diagrams/14-onboarding-flow.mmd) | New |
| [15-firm-research-agent](./diagrams/15-firm-research-agent.mmd) | New |
| [16-deal-import-flow](./diagrams/16-deal-import-flow.mmd) | New |
| [17-document-ingest-pipeline](./diagrams/17-document-ingest-pipeline.mmd) | New |
| [18-webnext-architecture](./diagrams/18-webnext-architecture.mmd) | New (Next.js app) |
| [19-deal-chat-react-agent](./diagrams/19-deal-chat-react-agent.mmd) | New (sequence) |
| [sample-auth-flow](./diagrams/sample-auth-flow.mmd) | Auth + invitation sequence |

## Operations & runbooks

- [Environment Setup](./ENVIRONMENT_SETUP.md)
- [Deployment](./DEPLOYMENT.md)
- [Database Migrations](./DATABASE_MIGRATIONS.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
- [Security](./SECURITY.md) + [Security Whitepaper](./SECURITY-WHITEPAPER.md)
- [Org Isolation Test Checklist](./ORG-ISOLATION-TEST-CHECKLIST.md)
- [QA Checklists](./QA-TEST-CHECKLIST-SESSION43.md), [Security Test Checklist](./SECURITY-TEST-CHECKLIST.md)
- [Supabase Auth Setup](./SUPABASE_AUTH_SETUP.md)
- [Supabase Architecture](./supabase-architecture.md)

## Design references

- [Stitch designs](./stitch-designs/)
- [UI/UX designer context](./ui-ux-designer-context.md)
- [Onboarding agent architecture](./onboarding-agent-architecture.md)
- [Firm research agent documentation](./firm-research-agent-documentation.md)
- [Testing guides — onboarding](./testing-guide-onboarding-flow.md), [firm research](./testing-guide-firm-research-agent.md), [AI features](./AI-FEATURES-TESTING-GUIDE.md), [deal import](./DEAL-IMPORT-TEST-GUIDE.md)

## Plans & specs

In-flight work is tracked in [`superpowers/plans/`](./superpowers/plans/) and [`superpowers/specs/`](./superpowers/specs/).

## Beta launch / sales

- [Beta Launch Kit](./BETA-LAUNCH-KIT.md)
- [Demo Cheatsheet](./DEMO-CHEATSHEET.md)
- [Avise Product Summary](./AVISE-PRODUCT-SUMMARY.md)
- [Competitive Landscape](./competitive-landscape-report.md)

## Hiring

- [`hiring/`](./hiring/) — open roles + interview material

---

**Maintenance.** When you finish work that changes counts (new agents, new routes, new pages, new diagrams), update:

1. The relevant feature doc in `docs/features/`
2. `docs/architecture/overview.md` if architecture changed
3. `docs/architecture/api-routes.md` if you added/removed a route file
4. The matching mermaid diagram in `docs/diagrams/`
5. This index if you created a new doc

Anything older than ~3 months should be re-verified against the codebase before being trusted.

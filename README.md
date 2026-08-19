# Avise — AI-Native Deal CRM for Private Equity

A multi-tenant AI-powered CRM purpose-built for PE firms and search funds. Track deal flow, ingest CIMs, extract financials with a self-correcting agent, draft IC memos, and run portfolio-wide AI analysis.

> **Status:** active development. `main` is production. **Last updated:** 2026-04-29.

---

## Contents

- [What's in here](#whats-in-here)
- [Diagrams](#diagrams)
- [Documentation](#documentation)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [API overview](#api-overview)
- [Scripts](#scripts)
- [Deployment](#deployment)

---

## What's in here

- **Two frontends.** `apps/web-next` (Next.js 16 + React 19 + Tailwind v4) is the primary product surface. `apps/web` (Vite + vanilla JS) is the legacy MPA we are migrating away from.
- **One Express + TypeScript API.** 48 route files, 37 service modules, **8 LangGraph / ReAct agents**.
- **Supabase Postgres** for data, auth, and storage. ~25 tables; multi-tenant via `Organization`.
- **Eight AI agents:** Financial (6-node LangGraph), Deal Chat (ReAct + 14 tools), Memo (pipeline), Firm Research (6-node + Phase-2 deep research), Contact Enrichment, Meeting Prep, Signal Monitor, Email Drafter.

## Features at a glance

- **Deal Pipeline** — 7-stage Kanban (`INITIAL_REVIEW → DUE_DILIGENCE → IOI_SUBMITTED → LOI_NEGOTIATION → CLOSING → CLOSED_WON`; terminals `CLOSED_LOST`, `PASSED`).
- **Deal Import** — CSV / Excel / paste up to 500 deals (~$0.01–0.02 per import via GPT-4o column mapping with deterministic overrides).
- **VDR (Virtual Data Room)** — folder tree + smart filters (4 built-in + 7 custom presets) + cross-folder search + folder insights.
- **Financial Extraction** — 6-node LangGraph: extract → verify → cross-verify → validate → self-correct → store. Three-layer extraction (Azure DI → pdf-parse + GPT-4o → GPT-4o Vision). Multi-document merge with DB-enforced active-row uniqueness.
- **PE Analysis Suite** — QoE, financial ratios, operational analysis, debt & LBO screen, red flags, EBITDA bridges.
- **Memo Builder** — section-by-section IC memos with AI grounding in the deal's financials.
- **Deal Chat** — ReAct agent with 14 tools (search docs, get financials, compare deals, update fields, change stage, add note, trigger extraction, draft email, prep meeting, scroll, suggest action).
- **Firm Research Agent** — onboarding firm enrichment (Phase 1 ≤ 60s) + background deep research (Phase 2 60–120s). Stores to `Organization.settings.firmProfile`.
- **Multi-tenancy** — every row org-scoped; 48 route files hardened; 34 integration tests; cross-org returns 404 (anti-enumeration).
- **RBAC** — `ADMIN`, `MEMBER`, `VIEWER`, `OPS` + per-deal access via `DealTeamMember`.
- **Onboarding** — 3-step standalone flow + persistent checklist that auto-backfills from real activity.
- **Admin Command Center** — ops/COO cockpit with task management, audit log, team roster, pending invitations.

## Diagrams

All diagrams are in [`docs/diagrams/`](docs/diagrams/) — Mermaid source (`.mmd`) plus rendered PNGs.

### System Architecture

> Two frontends, one Express API with 48 routes / 37 services / 8 agents, Supabase + OpenAI + Azure DI + Resend + Sentry + Vercel.

<p align="center">
  <a href="docs/diagrams/08-system-architecture.mmd"><img src="docs/diagrams/08-system-architecture.png" alt="System Architecture" width="100%"/></a>
</p>

### AI Agents Architecture

> Eight agents — Financial, Deal Chat (ReAct + 14 tools), Memo, Firm Research, Contact Enrichment, Meeting Prep, Signal Monitor, Email Drafter — all routed through the unified LLM layer.

<p align="center">
  <a href="docs/diagrams/12-ai-agents-architecture.mmd"><img src="docs/diagrams/12-ai-agents-architecture.png" alt="AI Agents Architecture" width="100%"/></a>
</p>

### Financial Extraction Pipeline

> 6-node LangGraph: extract → verify → cross-verify → validate → self-correct → store. Three-layer extraction (Azure DI → pdf-parse + GPT-4o → Vision) with self-correction loop.

<p align="center">
  <a href="docs/diagrams/11-financial-extraction-pipeline.mmd"><img src="docs/diagrams/11-financial-extraction-pipeline.png" alt="Financial Extraction Pipeline" width="100%"/></a>
</p>

### ER Diagram

> ~25 tables. Multi-tenant via `Organization`. All financial values in millions USD.

<p align="center">
  <a href="docs/diagrams/07-er-diagram.mmd"><img src="docs/diagrams/07-er-diagram.png" alt="ER Diagram" width="100%"/></a>
</p>

### Multi-Tenancy / Org Isolation

> Every row owned by an `Organization`. Two scoping patterns (direct FK + indirect via Deal). All 48 route files hardened. Cross-org access returns 404.

<p align="center">
  <a href="docs/diagrams/13-multi-tenancy-org-isolation.mmd"><img src="docs/diagrams/13-multi-tenancy-org-isolation.png" alt="Multi-Tenancy / Org Isolation" width="100%"/></a>
</p>

### Deal Lifecycle

> 7 pipeline stages, 3 terminal states, deals enter via manual create, CIM upload, URL ingest, or email forward.

<p align="center">
  <a href="docs/diagrams/02-deal-lifecycle.mmd"><img src="docs/diagrams/02-deal-lifecycle.png" alt="Deal Lifecycle" width="100%"/></a>
</p>

### Onboarding Flow

> Signup → auto-provision Organization → welcome modal → 3-step onboarding (firm focus → upload deal → invite team) → persistent checklist with auto-backfill from real activity.

<p align="center">
  <a href="docs/diagrams/14-onboarding-flow.mmd"><img src="docs/diagrams/14-onboarding-flow.png" alt="Onboarding Flow" width="100%"/></a>
</p>

### Firm Research Agent

> Phase 1 sync (≤ 60s): scrape → search firm → search person → synthesize → verify → save. Phase 2 async (60–120s): GPT-4o derives 8–12 follow-up queries and recurses.

<p align="center">
  <a href="docs/diagrams/15-firm-research-agent.mmd"><img src="docs/diagrams/15-firm-research-agent.png" alt="Firm Research Agent" width="100%"/></a>
</p>

### Deal Import Flow

> CSV / Excel / paste → GPT-4o column mapping with deterministic overrides → preview → 5-phase batch insert (up to 500 deals at ~$0.01–0.02 per import).

<p align="center">
  <a href="docs/diagrams/16-deal-import-flow.mmd"><img src="docs/diagrams/16-deal-import-flow.png" alt="Deal Import Flow" width="100%"/></a>
</p>

### Document Ingest Pipeline

> Five entry points (upload, URL, email, paste, VDR) → magic-bytes validation → Supabase Storage → parse → financial branch (Financial Agent) or chunking (DocumentChunk for VDR search).

<p align="center">
  <a href="docs/diagrams/17-document-ingest-pipeline.mmd"><img src="docs/diagrams/17-document-ingest-pipeline.png" alt="Document Ingest Pipeline" width="100%"/></a>
</p>

### Memo Builder Flow

> Template-based memo creation with section-by-section AI generation grounded in deal data.

<p align="center">
  <a href="docs/diagrams/04-memo-builder-flow.mmd"><img src="docs/diagrams/04-memo-builder-flow.png" alt="Memo Builder Flow" width="100%"/></a>
</p>

### Document & VDR Flow

> Folder-based document workspace with smart filters, cross-folder search, document requests via Resend, and folder-level AI insights.

<p align="center">
  <a href="docs/diagrams/03-document-vdr-flow.mmd"><img src="docs/diagrams/03-document-vdr-flow.png" alt="Document & VDR Flow" width="100%"/></a>
</p>

### Web-Next Architecture

> Next.js 16 App Router with route groups: `(auth)`, `(onboarding)`, `(app)`. The `/api/[...slug]` route proxies to the Express API and forwards the JWT.

<p align="center">
  <a href="docs/diagrams/18-webnext-architecture.mmd"><img src="docs/diagrams/18-webnext-architecture.png" alt="Web-Next Architecture" width="100%"/></a>
</p>

### Deal Chat — ReAct Agent (Sequence)

> POST `/api/deals/:id/chat` → `runDealChatAgent` with 14 closure-bound tools → returns response + updates + sideEffects for optimistic UI.

<p align="center">
  <a href="docs/diagrams/19-deal-chat-react-agent.mmd"><img src="docs/diagrams/19-deal-chat-react-agent.png" alt="Deal Chat ReAct Agent" width="100%"/></a>
</p>

### Auth Flow (Sequence)

> Signup, first-login auto-provision, subsequent login, invitation, accept-invitation, password reset, RBAC.

<p align="center">
  <a href="docs/diagrams/sample-auth-flow.mmd"><img src="docs/diagrams/sample-auth-flow.png" alt="Auth Flow" width="100%"/></a>
</p>

### Other diagrams

- [Role Access Matrix](docs/diagrams/09-role-access-matrix.mmd) — what each role can do
- [Navigation / Page Flow](docs/diagrams/10-navigation-page-flow.mmd) — frontend page graph
- [User Journey — Admin](docs/diagrams/05-user-journey-admin.mmd)
- [User Journey — Analyst](docs/diagrams/06-user-journey-analyst.mmd)

To re-render a diagram from its `.mmd` source:

```bash
npx -p @mermaid-js/mermaid-cli mmdc -i docs/diagrams/08-system-architecture.mmd -o docs/diagrams/08-system-architecture.png -b transparent -w 2400
```

## Documentation

Full docs tree: [`docs/README.md`](docs/README.md). Start here:

| Read this if you... | Doc |
| --- | --- |
| just joined the team | [New Teammate Guide](docs/onboarding/new-teammate-guide.md) |
| need a system mental model | [Architecture Overview](docs/architecture/overview.md) |
| are touching the schema | [Data Model](docs/architecture/data-model.md) |
| are touching the API | [API Routes](docs/architecture/api-routes.md) |
| are touching agents/AI | [AI Agents](docs/architecture/ai-agents.md) |
| need to verify multi-tenancy | [Security](docs/architecture/security.md) |
| want a flow walk-through | [User Flows](docs/user-flows/) |
| want product-level feature docs | [Features](docs/features/) |
| are deploying or operating | [Deployment](docs/DEPLOYMENT.md), [Environment Setup](docs/ENVIRONMENT_SETUP.md), [Troubleshooting](docs/TROUBLESHOOTING.md) |

## Tech stack

| Layer | Tools |
| --- | --- |
| Primary frontend | Next.js 16 + React 19 + Tailwind v4 (`apps/web-next`, port 3002) |
| Legacy frontend | Vite + vanilla JS + Tailwind (`apps/web`, port 3003). 30 HTML pages + 39 JS modules. VDR is React/Vite. |
| Backend | Express + TypeScript (`apps/api`, port 3001). Zod validation. Pino logging. |
| Database | Supabase (Postgres + Auth + Storage) |
| AI | OpenAI GPT-4o + GPT-4o-mini via unified `services/llm.ts`; Gemini and Anthropic supported as alternates |
| Agent framework | LangGraph + LangChain (`@langchain/langgraph`, `@langchain/openai`, `@langchain/core`) |
| Document parsing | pdf-parse, xlsx, mammoth, mailparser; Azure Document Intelligence + LlamaParse as deep-parse fallbacks |
| Web scraping | Apify Google Search + DuckDuckGo Lite fallback |
| Email | Resend |
| Error tracking | Sentry |
| Hosting | Vercel (single deployment: Next.js + serverless API) |
| Build | Turborepo |
| Testing | Vitest + Supertest (API), Playwright (web), Vitest (web-next) |

## Project structure

```
AI CRM/
├── apps/
│   ├── api/                       # Express + TypeScript (port 3001)
│   │   └── src/
│   │       ├── app.ts             # Middleware stack + route mounting
│   │       ├── index.ts           # Bootstraps Express
│   │       ├── middleware/        # auth, orgScope, rbac, errorHandler, requestId
│   │       ├── routes/            # 48 route files
│   │       └── services/          # 37 service files + agents/ + analysis/ + parsers/
│   ├── web-next/                  # Next.js 16 — primary (port 3002)
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (auth)/        # login, signup, verify, forgot, reset, accept-invite
│   │       │   ├── (onboarding)/  # standalone onboarding
│   │       │   ├── (app)/         # authenticated routes
│   │       │   └── api/[...slug]/ # proxy to Express API
│   │       ├── components/        # ui, layout, vdr, deal-actions, onboarding
│   │       ├── lib/               # supabase, vdr, utils
│   │       └── providers/         # auth, theme, toast
│   ├── web/                       # Legacy vanilla JS (port 3003)
│   └── extractor/                 # Standalone extractor utility
├── packages/
│   ├── ui/                        # Shared React components / styles
│   └── shared/                    # Shared TypeScript types (legacy)
├── docs/                          # All documentation
│   ├── architecture/              # Overview, data model, API routes, AI agents, security
│   ├── user-flows/                # End-to-end flows
│   ├── features/                  # Per-feature docs
│   ├── onboarding/                # New teammate guide
│   └── diagrams/                  # Mermaid + PNG
├── scripts/                       # Repo helpers
├── render.yaml                    # Render blueprint (legacy)
├── vercel.json                    # Vercel config
├── turbo.json                     # Turborepo pipeline
└── package.json
```

## Quick start

### Prerequisites

- Node.js ≥ 18
- npm ≥ 10
- A [Supabase](https://supabase.com) project
- (Optional) OpenAI / Anthropic / Gemini / Azure DI / Apify / Resend / Sentry credentials

### Install

```bash
git clone <repo>
cd "AI CRM"
npm install
```

### Configure env

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# Web-next inherits via next.config.ts
```

Required: `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Optional but useful: `OPENAI_API_KEY`, `AZURE_DI_KEY`, `APIFY_API_TOKEN`, `RESEND_API_KEY`, `SENTRY_DSN`. Full list in [`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md).

### Run

```bash
npm run dev
```

That spins up everything via Turborepo:

| Service | URL |
| --- | --- |
| API | http://localhost:3001 |
| Web-next (primary) | http://localhost:3002 |
| Legacy web | http://localhost:3003 |
| API health | http://localhost:3001/health |
| API readiness | http://localhost:3001/health/ready |

> **Port note:** 3000 is reserved for the main-branch worktree's legacy `apps/web` (Vite default). If `web-next` can't bind 3002 it'll pick another free port and may collide with API — kill stale processes first.

### Single-app dev

```bash
npm run dev:api
npm run dev:web-next
npm run dev:web
```

### Tests & type-check

```bash
cd apps/api
npm test                         # Vitest
npm run test:org-isolation       # Multi-tenancy integration tests (run before merging)
npm run test:coverage

cd apps/api && npx tsc --noEmit
cd apps/web-next && npx tsc --noEmit
```

## API overview

All routes under `/api/*`. Auth via Bearer JWT (Supabase). See [`docs/architecture/api-routes.md`](docs/architecture/api-routes.md) for the complete map.

| Resource | Endpoints (selection) |
| --- | --- |
| Deals | `GET/POST /api/deals`, `GET/PATCH/DELETE /api/deals/:id`, `GET /api/deals/stats/summary`, `POST /api/deals/import`, `POST /api/deals/import/analyze` |
| Companies | `GET/POST/PATCH/DELETE /api/companies` |
| Documents | `GET /api/deals/:id/documents`, `POST /api/deals/:id/documents/upload` |
| Folders | `GET/POST/PATCH/DELETE /api/folders`, `GET /api/folders/:id/insights` |
| Financials | `GET /api/financials`, `POST /api/financials/extract`, `GET /api/financials/conflicts`, `POST /api/financials/resolve` |
| Memos | `GET/POST /api/memos`, `POST /api/memos/:id/sections/:id/generate`, `POST /api/memos/:id/chat` |
| Templates | `GET/POST/PATCH/DELETE /api/templates` |
| Users | `GET /api/users/me`, `GET/PATCH /api/users/profile`, `GET /api/users` |
| Contacts | `GET/POST/PATCH/DELETE /api/contacts`, `GET /api/contacts/insights` |
| AI | `POST /api/deals/:id/chat`, `POST /api/ai/portfolio/chat`, `POST /api/ai/enrich-contact`, `POST /api/ai/meeting-prep`, `POST /api/ai/draft-email`, `POST /api/ai/scan-signals` |
| Onboarding | `GET /api/onboarding/status`, `PATCH /api/onboarding/step`, `POST /api/onboarding/enrich-firm`, `GET /api/onboarding/research-status` |
| Ingest | `POST /api/ingest/upload`, `POST /api/ingest/url`, `POST /api/ingest/email`, `POST /api/ingest/text` |
| Tasks | `GET/POST/PATCH/DELETE /api/tasks` |
| Notifications | `GET /api/notifications`, `POST /api/notifications/mark-all-read` |
| Invitations | `GET/POST /api/invitations`, `DELETE /api/invitations/:id`, `POST /api/invitations/:id/resend`, `GET /api/public/invitations/verify/:token`, `POST /api/public/invitations/accept` |
| Audit | `GET /api/audit` (admin) |
| Watchlist | `GET/POST /api/watchlist` |
| Export | `GET /api/export/...` |
| Health | `GET /health`, `GET /health/ready` |

Rate limits (per-user, keyed by token suffix): general 600/15min, AI 10/min, write 30/min.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | All services via Turborepo |
| `npm run dev:api` | API only |
| `npm run dev:web-next` | Next.js only |
| `npm run dev:web` | Legacy web only |
| `npm run build` | Build everything |
| `npm run build:prod` | Production bundle |
| `npm run start:prod` | Start production server |
| `cd apps/api && npm test` | API tests |
| `cd apps/api && npm run test:org-isolation` | Multi-tenancy tests |
| `cd apps/api && npx tsc --noEmit` | API type-check |
| `cd apps/web-next && npx tsc --noEmit` | Web-next type-check |

## Deployment

Production runs on **Vercel** as a single deployment with the Express API as serverless functions. Render is legacy (no longer used). See [Deployment Guide](docs/DEPLOYMENT.md).

```bash
npm run build:prod
NODE_ENV=production node apps/api/dist/index.js
```

## License

Private and confidential.

---

**Maintained by Ganesh Jagtap.** Only `@ganeshjagtap7` can approve merges to `main` (CODEOWNERS).

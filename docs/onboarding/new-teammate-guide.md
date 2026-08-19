# New Teammate Guide

> If you've just joined the team — read this first. By the end you'll know the layout, how to run the stack, where every feature lives, and how we work day-to-day.

**Estimated time to "productive":** half a day to read + bootstrap; one day to your first PR.

## Day 0 — Access

Ask Ganesh (the user) for:

1. GitHub access to the repo. Note: only `@ganeshjagtap7` can approve merges to `main` (CODEOWNERS).
2. Supabase project access (read-only at first).
3. Vercel access (read access; deploys are automatic from `main`).
4. Sentry access for error monitoring.
5. OpenAI / Anthropic / Apify keys for local dev (or use shared dev keys).

Tools you'll use locally: **Node 18+**, **npm 10+**, a terminal, your editor of choice.

## Day 1 — Get the stack running

### Clone and install

```bash
git clone <repo>
cd "AI CRM"
npm install            # installs all workspaces via Turborepo
```

### Configure env

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# Web-next inherits from apps/web-next/.env if you create one (next.config.ts handles the rest)
```

Required at minimum:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- `OPENAI_API_KEY` (for AI features)

Optional but very useful:

- `AZURE_DI_KEY` + `AZURE_DI_ENDPOINT` — better PDF extraction
- `APIFY_API_TOKEN` — Firm Research Agent
- `RESEND_API_KEY` — invitation emails
- `SENTRY_DSN` — error tracking

Full list: [`docs/ENVIRONMENT_SETUP.md`](../ENVIRONMENT_SETUP.md).

### Run

```bash
npm run dev
```

That starts everything via Turborepo:

- API on `http://localhost:3001` — health: `/health`, readiness: `/health/ready`
- Web-next on `http://localhost:3002` — primary frontend
- Legacy web on `http://localhost:3003`

You can also run a single app:

```bash
npm run dev:api
npm run dev:web-next
npm run dev:web
```

### Sanity check

- `curl localhost:3001/health` → `{ status: ok }`
- Open `localhost:3002` → see the Next.js login page
- Sign up with your email — first user becomes ADMIN of a fresh org
- Run the onboarding flow end-to-end: define investment focus, drop a sample CIM, try the chat

## Day 1 afternoon — Read these in order

You don't need to read every doc. These are the seven that give you a working mental model.

1. [`docs/architecture/overview.md`](../architecture/overview.md) — the full system in one page
2. [`docs/architecture/data-model.md`](../architecture/data-model.md) — every table
3. [`docs/architecture/api-routes.md`](../architecture/api-routes.md) — every route file
4. [`docs/architecture/ai-agents.md`](../architecture/ai-agents.md) — the eight agents
5. [`docs/architecture/security.md`](../architecture/security.md) — auth, RBAC, multi-tenancy
6. [`docs/diagrams/08-system-architecture.mmd`](../diagrams/08-system-architecture.mmd) — picture worth 1000 words
7. [`docs/diagrams/07-er-diagram.mmd`](../diagrams/07-er-diagram.mmd) — the ER model

After those you can dip into any feature doc as needed: [`docs/features/`](../features/).

## How we work

### Branching

`main` is production. Feature branches off main; merge via PR. Conventional commits (`feat(scope):`, `fix(scope):`, `docs(scope):`).

`@ganeshjagtap7` is the only approver via CODEOWNERS — that's intentional. Don't try to bypass it.

### Code style

Concise, direct, no over-engineering. Specific rules in [`AGENTS.md`](../../AGENTS.md):

- Files under 500 lines. Split if growing.
- No magic strings — use constants from `utils/constants.ts` (API) or `js/config.js` (web).
- No duplicate utility functions — use shared modules.
- Routes thin; business logic in services.
- Custom error classes from `middleware/errorHandler.ts` (don't throw raw `Error`).
- All routes are org-scoped — never skip org checks.
- Conventional commits.

UI conventions:

- Banker Blue `#003366`, white cards, Inter font, bg `#F8F9FA`
- All primary buttons `background-color: #003366` via inline style
- Never use `bg-slate-900`
- Tailwind opacity on dark colors (`bg-primary/[0.05]`) is invisible on white — use hex
- `overflow-x-auto` clips dropdowns — use `flex-wrap` instead

### Tests

```bash
cd apps/api
npm test                       # full Vitest suite
npm run test:org-isolation     # multi-tenancy tests (run before merging anything tenanted)
npm run test:coverage
```

Frontend: Playwright tests in `apps/web/tests/`. Web-next has Vitest.

### Type-checking

```bash
cd apps/api && npx tsc --noEmit
cd apps/web-next && npx tsc --noEmit
```

### Where to find things

| You want to... | Look here |
| --- | --- |
| Change a Deal field | `apps/api/src/routes/deals.ts` + `apps/web/js/deal.js` (or `apps/web-next/src/app/(app)/deals/`) |
| Add a chat tool | `apps/api/src/services/agents/dealChatAgent/tools.ts` |
| Add an onboarding step | `apps/web/js/onboarding/onboarding-config.js` + `routes/onboarding.ts` |
| Tweak a prompt | `apps/api/src/services/agents/<agent>/` — usually `prompts.ts` or inline in `index.ts` |
| Add a new diagram | `docs/diagrams/<NN>-name.mmd` and reference it from a doc |
| Document a new feature | `docs/features/<name>.md` and add to [`docs/features/README.md`](../features/README.md) |

### Useful daily commands

```bash
# Full type check
cd apps/api && npx tsc --noEmit
cd apps/web-next && npx tsc --noEmit

# API logs
cd apps/api && npm run dev   # uses tsx watch

# Build everything
npm run build
```

## Common gotchas you'll hit

- **Wrong port collision.** Vite picks 3000 by default — that's the main-branch worktree's web. Web-next is 3002, web is 3003, API is 3001.
- **Auth UUID mismatch.** Frontend has `session.user.id` (Supabase Auth UUID) ≠ `User.id`. Match via `User.authId`.
- **Missing folder ID** on document upload makes documents vanish. `documents-upload.ts` auto-fills it.
- **`overflow-x-auto`** clips dropdowns. Use `flex-wrap`.
- **Tailwind opacity on dark colors** like `bg-primary/[0.05]` is invisible. Use hex.
- **Compound `extractionSource`** values like `'gpt4o-excel'` are rejected by DB CHECK. Use one of `gpt4o`, `azure`, `vision`, `manual`.
- **Cross-org access** must return 404 not 403.
- **Circular imports** — `ingest.ts` ↔ `ingest-upload.ts` was once circular. Fixed via `ingest-shared.ts`. Don't reintroduce.

## Day 2+ — Pick up an issue

Look at:

- Linear / GitHub Issues for tasks
- `progress.md` (root of repo) for the running session log

Ask in Slack / DM if you're stuck more than 30 minutes — the team prefers chat over silent investigation.

## Glossary

- **Avise** — the product (this repo).
- **CIM** — Confidential Information Memorandum — the doc a banker sends with a deal.
- **IC memo** — Investment Committee memo — the internal write-up to get approval.
- **VDR** — Virtual Data Room — folder-based document workspace per deal.
- **QoE** — Quality of Earnings — diligence on how reliable EBITDA is.
- **MOIC / MoM** — Multiple of Invested Capital — return metric.
- **LBO** — Leveraged Buyout — common PE deal structure.
- **LangGraph** — graph-based orchestration framework we use for multi-step agents.
- **ReAct** — "Reason + Act" — agent pattern where the LLM picks tools to call iteratively.
- **Org** / **Tenant** — `Organization` row, the multi-tenancy boundary.

## What this repo is *not*

To save you from going down dead ends:

- It's not a generic CRM. Every concept is wired toward PE deal flow specifically.
- It's not multi-region — single Supabase + single Vercel deployment.
- It's not on-prem; it's a SaaS product.
- The legacy `apps/web` is being phased out. Don't add new features there.

## Help & support

Inside the app: top-right user dropdown → "Help & Support".

For engineering questions, the codebase comments and [`AGENTS.md`](../../AGENTS.md) are the source of truth, then this docs tree.

For domain (PE) questions, ask the partners.

Welcome to the team.

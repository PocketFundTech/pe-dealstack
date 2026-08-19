# Avise — Web (Next.js)

Avise is the Next.js frontend for Pocket Fund's AI-powered CRM for private equity. It replaced the legacy vanilla-JS app at `apps/web` in April 2026 and is now the primary product surface — deals, VDR, financials, memo builder, dashboard, admin, deal chat, and the onboarding flow all live here.

For a top-down view of the monorepo (API, agents, schema, diagrams), see the root [`README.md`](../../README.md).

---

## Tech stack

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router) |
| UI | React 19 |
| Styling | Tailwind CSS v4 (PostCSS plugin) |
| Auth | Supabase (`@supabase/ssr` + `@supabase/supabase-js`), Bearer JWT to the API |
| Charts | `chart.js` + `react-chartjs-2` |
| HTML sanitizer | `dompurify` |
| PDF export | `html2pdf.js` |
| Testing | Vitest |
| Hosting | Vercel — single project, the catch-all `/api/[...slug]/route.ts` dynamically imports the compiled Express bundles in `apps/api/dist/` (`app-lite.js` and `app-ai.js`). |

> **Heads-up.** Next.js 16, React 19, and Tailwind v4 are bleeding-edge. APIs and conventions differ from older docs and from most LLM training data. Read `node_modules/next/dist/docs/` (or the official upgrade guides) before assuming an API exists. See [`AGENTS.md`](AGENTS.md).

---

## Getting started

### Prereqs

- Node ≥ 18, npm ≥ 10
- A Supabase project (URL + anon key)
- The API running locally — the dev server proxies `/api/*` to it

### Run the dev stack

```bash
# from the repo root, easiest path:
npm run dev                  # all apps via Turborepo

# or just this app + the API:
cd apps/api      && npm run dev    # :3001
cd apps/web-next && npm install    # first time only
cd apps/web-next && npm run dev    # :3002
```

Open <http://localhost:3002>. The dev server proxies `/api/*` to `http://localhost:3001` via the rewrite in [`next.config.ts`](next.config.ts) (override with `API_PROXY_URL`).

> If `:3002` is taken, Next will pick another free port — and may collide with the API on `:3001`. Kill stale processes first.

### Env vars

Copy `.env.example` to `.env.local` and fill in. At minimum:

| Var | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Supabase anon key |
| `API_PROXY_URL` | dev only | Defaults to `http://localhost:3001`. Used by the dev rewrite in `next.config.ts`; ignored in production. |

In production (Vercel) the API runs as a Node Function colocated with the Next app, so no proxy URL is needed — `/api/*` resolves through the Route Handler.

### Running tests

```bash
cd apps/web-next
npm run test             # run all tests once (Vitest, jsdom)
npm run test:watch       # watch mode
```

Vitest is configured via [`vitest.config.ts`](vitest.config.ts) with `jsdom`, the `@/*` → `src/*` alias, and `src/test/setup.ts` which registers `@testing-library/jest-dom` matchers and stubs `next/navigation` + `next/link`. Use the `renderWithProviders` helper from [`src/test/render.tsx`](src/test/render.tsx) to mount components inside the providers (`ToastProvider` by default; opt out with `withToast: false`).

---

## Project structure

```
apps/web-next/
├── next.config.ts          # outputFileTracingRoot, dev /api proxy, security headers
├── vercel.json             # Per-app Vercel hints (root vercel.json owns the build)
├── AGENTS.md               # Next 16 / React 19 / Tailwind v4 reminder for agents
├── CLAUDE.md               # Project-specific agent guidance (this app only)
└── src/
    ├── app/
    │   ├── (auth)/         # login, signup, verify-email, forgot-password,
    │   │                   #   reset-password, accept-invite
    │   ├── (onboarding)/   # standalone onboarding flow (3 steps)
    │   ├── (app)/          # authenticated routes — dashboard, deals,
    │   │                   #   data-room, contacts, memo-builder, templates,
    │   │                   #   deal-intake, admin, settings, coming-soon
    │   ├── api/[...slug]/  # catch-all Route Handler that proxies every
    │   │                   #   /api/* request to the Express bundles
    │   │                   #   (app-lite.js / app-ai.js) via api-adapter.ts
    │   ├── layout.tsx
    │   └── page.tsx        # marketing / landing
    ├── components/         # ui, layout, vdr, deal-actions, deal-intake,
    │                       #   onboarding
    ├── lib/                # api.ts (auth wrapper), api-adapter.ts (Express
    │                       #   ↔ Web Response shim), api-bundles.ts (lite vs
    │                       #   ai bundle picker), supabase/, vdr/, formatters,
    │                       #   constants, markdown, storageKeys
    ├── providers/          # AuthProvider, UserProvider, ToastProvider,
    │                       #   NotificationCountProvider, PresenceProvider,
    │                       #   IngestDealModalProvider
    ├── middleware.ts       # Supabase session refresh + auth redirects
    └── types/
```

**Route group conventions:**
- `(auth)` — unauthenticated entry points; their layout intentionally has no sidebar/header.
- `(onboarding)` — gated standalone flow for first-time users (no app chrome).
- `(app)` — every authenticated screen. Layout mounts the sidebar, header, providers, and presence.

---

## Deployment

Production runs on **Vercel** as a single project. The repo-root [`vercel.json`](../../vercel.json) is the source of truth:

- `outputDirectory` → `apps/web-next/.next`
- `buildCommand` → builds the API bundles first, then the Next app
- `functions["apps/web-next/src/app/api/[...slug]/route.ts"]` — bumped to `memory: 1769` and `maxDuration: 300` so the AI paths (memo generation, multi-doc ingest) don't hit a 60s wall

The catch-all Route Handler at `src/app/api/[...slug]/route.ts` lazy-loads the compiled Express bundles via dynamic `import("../../../api/dist/app-lite.js")` / `app-ai.js`. `api-bundles.ts` decides which bundle handles a given pathname (mirrors the legacy `vercel.json` rewrite list — `/api/ai/*`, deal AI suffixes, `/api/memos/*`, `/api/ingest`, `/api/onboarding` go to the `ai` bundle; everything else goes to `lite`).

`next.config.ts` sets:
- `outputFileTracingRoot: "../../"` — npm workspaces hoist `node_modules` to the repo root; without this Next's tracer misses `next/dist/compiled/*` and the lambda packaging breaks.
- `serverExternalPackages: [...]` — keeps Express, Supabase, OpenAI, LangChain, Azure DI, etc. external so the file tracer follows the imports and packages the matching `node_modules` automatically (instead of webpack trying to bundle dynamic requires).

See the root [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md) for the full deployment runbook.

---

## Key gotchas

- **Bracket-escaped routes in tracing.** The Route Handler at `src/app/api/[...slug]/route.ts` uses bracket notation in its path. Anything that globs over file-tracing config or vercel function paths must escape the `[...]` literally — see `vercel.json` for the actual key (`apps/web-next/src/app/api/[...slug]/route.ts`).
- **Auth is Bearer JWT to Express.** `src/lib/api.ts` calls `supabase.auth.getUser()` first (server-validated) before reading the access token from the session, then forwards it as `Authorization: Bearer <jwt>`. The Express middleware in `apps/api/src/middleware/auth.ts` does the verification. Don't roll your own client-side `fetch` — go through `api.get/post/patch/delete`.
- **Body size limits live on the API, not Next.** The Vercel Function default is generous; the constraints come from `express.json({ limit: "50mb" })` and multer's per-route limits (50–100MB on the 5 upload routes). The Route Handler streams the raw body through unchanged.
- **`overflow-x-auto` clips dropdowns.** Use `flex-wrap` instead. Tailwind opacity on dark hex (`bg-[#003366]/[0.05]`) is invisible on white — use plain hex or a `/10` neutral.
- **Primary buttons are inline-styled.** Banker Blue `#003366` via `style={{ backgroundColor: "#003366" }}`, not a Tailwind utility — matches the rule in the repo-wide agent guide so the tone is consistent across legacy and new.

See [`CLAUDE.md`](CLAUDE.md) for the full agent-facing guidance.

---

## Related docs

- Root [`README.md`](../../README.md) — monorepo overview, diagrams, API map
- [`../../docs/architecture/`](../../docs/architecture/) — overview, data model, API routes, AI agents, security
- [`../../docs/MIGRATION-AUDIT-REPORT.md`](../../docs/MIGRATION-AUDIT-REPORT.md) — what came over from `apps/web`, what didn't, and the open follow-ups (file-size violations, empty catches, native `alert()` calls)
- [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md), [`../../docs/ENVIRONMENT_SETUP.md`](../../docs/ENVIRONMENT_SETUP.md), [`../../docs/TROUBLESHOOTING.md`](../../docs/TROUBLESHOOTING.md)
- [`AGENTS.md`](AGENTS.md) — short Next 16 reminder for AI agents

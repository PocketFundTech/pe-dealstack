# Avise — AI-Powered CRM for Private Equity

## Project Structure

```
apps/
  api/          Express + TypeScript API (Supabase PostgreSQL)
  web/          Legacy vanilla JS frontend + React VDR (Vite) — :3003
  web-next/     Next.js 16 + React 19 + Tailwind v4 app (primary) — :3002
docs/           Architecture docs, planning, diagrams
packages/       ui/ (shared React components/styles), etc.
```

### Coding Standards

### General
- Keep files under 500 lines. Split when they grow beyond this.
- No magic strings — use constants from `utils/constants.ts` (API) or `js/config.js` (web).
- No duplicate utility functions — use shared modules.

### Frontend (apps/web/)
- **Shared modules** must be loaded in this order in HTML:
  1. `js/auth.js` — Supabase auth + PEAuth singleton
  2. `js/config.js` — API_BASE_URL + PE_CONFIG
  3. `js/formatters.js` — formatCurrency, formatFileSize, escapeHtml, etc.
  4. `js/notifications.js` — showNotification (title, message, type)
  5. `js/layout.js` — sidebar + header
- Never define API_BASE_URL, showNotification, or formatCurrency inline — they live in shared modules.
- Use `PEAuth.authFetch()` for all API calls (handles tokens + refresh).
- UI theme: Banker Blue `#003366`, white cards, Inter font, bg `#F8F9FA`.
- All primary buttons: `background-color: #003366` via inline style (not Tailwind).

### API (apps/api/src/)
- Routes should be thin — validate input, call service, return response.
- Business logic belongs in `services/` files.
- Use custom error classes from `middleware/errorHandler.ts` (ValidationError, NotFoundError, etc.).
- All routes are org-scoped via `orgMiddleware` — never skip org checks.
- Conventional commits: `feat(scope):`, `fix(scope):`, `docs(scope):`.

### Database
- Financial extraction sources: only `'gpt4o'`, `'azure'`, `'vision'`, `'manual'` (DB CHECK constraint).
- Statement types: `'INCOME_STATEMENT'`, `'BALANCE_SHEET'`, `'CASH_FLOW'`.
- Values stored in millions USD.

## Key Commands
```bash
# Development
cd apps/api && npm run dev        # API on :3001
cd apps/web-next && npm run dev   # Next.js app on :3002 (primary)
cd apps/web && npm run dev        # Legacy vanilla app on :3003
                                  # Port note: :3000 is reserved for the main-branch
                                  # worktree's apps/web (Vite default) so side-by-side
                                  # port isn't stepped on while the migration is in flight.

# Type check
cd apps/api && npx tsc --noEmit
cd apps/web-next && npx tsc --noEmit

# Build
npm run build                 # Turborepo builds all apps
```

## Common Gotchas
- `overflow-x-auto` clips dropdown menus — use `flex-wrap` instead.
- Tailwind opacity on dark colors (`bg-primary/[0.05]`) is invisible on white — use hex.
- Partial unique index `WHERE isActive = true` enforces one active financial statement per period.
- Dev ports: web-next owns :3002, web owns :3003, api owns :3001. Port :3000 is left free for the main-branch worktree's legacy apps/web (Vite defaults to 3000). If web-next can't bind :3002 it'll pick another free port and may collide with api — kill stale processes first.
- `apps/web-next/` runs Next.js 16 + React 19 + Tailwind v4 (bleeding-edge). APIs and conventions may differ from older Next docs — read `node_modules/next/dist/docs/` before guessing.

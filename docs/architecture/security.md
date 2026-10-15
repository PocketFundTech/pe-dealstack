# Security & Multi-Tenancy

> Concrete guarantees, not aspirations. Read this before touching any route, query, or middleware.

This complements the existing [`docs/SECURITY.md`](../SECURITY.md) and [`docs/SECURITY-WHITEPAPER.md`](../SECURITY-WHITEPAPER.md). Keep this doc focused on the operational rules.

## Authentication

Supabase JWT, Bearer tokens, no sessions on the API.

- Frontend acquires the token via `supabase.auth.signInWithPassword()` and persists session to local storage. The legacy app uses the `PEAuth` singleton (`apps/web/js/auth.js`); the Next.js app uses `@supabase/ssr` with a cookie-backed session.
- Every API call must go through `PEAuth.authFetch()` (legacy) or the `/api/[...slug]` proxy (Next.js). Both attach the `Authorization: Bearer <jwt>` header automatically and refresh expiring tokens.
- [`authMiddleware`](../../apps/api/src/middleware/auth.ts) verifies the token against Supabase and stamps `req.authId`.
- [`orgMiddleware`](../../apps/api/src/middleware/orgScope.ts) resolves `User WHERE authId = ?` and stamps `req.userId`, `req.organizationId`, `req.userRole`. **The Supabase Auth UUID is not the same as `User.id`.** Always resolve via `authId`.

If a request reaches a protected handler, those three fields are guaranteed populated.

## Authorization (RBAC)

Roles: `ADMIN`, `MEMBER`, `VIEWER`, `OPS`.

- ADMIN — full org access; user management; invite/revoke; admin dashboard.
- MEMBER — standard access; deal operations.
- OPS — operations role; limited AI usage.
- VIEWER — read-only.

Enforcement is done with [`rbacMiddleware`](../../apps/api/src/middleware/rbac.ts) at the route level. RBAC must always run **after** `orgMiddleware` so `req.userRole` is set. Front-end shows/hides UI based on role but treats it as a UX hint — the API is the source of truth.

`DealTeamMember.accessLevel` (`view | edit | admin`) layers per-deal permissions on top of the org role for sensitive deals.

## Multi-tenancy isolation

Every row belongs to an Organization. There are two correct query patterns:

```ts
// Direct-FK tables (Deal, Contact, Memo, etc.)
const { data } = await supabase
  .from('Deal')
  .select('*')
  .eq('organizationId', orgId);

// Indirect via Deal (Document, Folder, FinancialStatement, etc.)
await verifyDealAccess(dealId, orgId); // throws NotFoundError if cross-org
const { data } = await supabase
  .from('Document')
  .select('*')
  .eq('dealId', dealId);
```

**Cross-org access returns 404 (not 403)** so attackers can't enumerate IDs.

All 48 route files apply one of these two patterns. The integration test suite at [`apps/api/tests/org-isolation.test.ts`](../../apps/api/tests/org-isolation.test.ts) validates with 34 cases (26 cross-org-blocked + 8 same-org-works). Run before merging anything that touches a tenanted resource:

```bash
cd apps/api && npm run test:org-isolation
```

QA team's manual checklist: [`docs/ORG-ISOLATION-TEST-CHECKLIST.md`](../ORG-ISOLATION-TEST-CHECKLIST.md).

## Rate limiting

[`express-rate-limit`](../../apps/api/src/app.ts) keyed by Bearer token suffix (last 16 chars), falling back to `X-Forwarded-For`:

| Bucket | Limit | Reason |
| --- | --- | --- |
| general | 600 / 15 min | SPA navigation in a busy page can hit hundreds of `/api/*` calls |
| AI | 10 / min | OpenAI calls are expensive |
| write (`/api/ingest`) | 30 / min | Ingest can run extraction agents |

`app.set('trust proxy', 1)` is set so we read real client IP behind Vercel/Render. **Don't** use unauthenticated fall-through that could let an attacker pool multiple users into one bucket.

## CORS

Origin allowlist + Vercel preview-domain regex. Sources:

- `https://app.avise.io`, `https://pe-dealstack.vercel.app`, `https://pe-dealstack-nextjs.vercel.app`, `https://lmmos.ai`, `https://www.lmmos.ai`
- `previewOriginRegex = /^https:\/\/pe-dealstack(-nextjs)?-[a-z0-9-]+\.vercel\.app$/`
- Anything in `ALLOWED_ORIGINS` env var (comma-separated)
- localhost ports in dev only

Rejected origins are logged via `log.warn` and rejected with the `cors` callback's error.

## Request integrity

- [`requestIdMiddleware`](../../apps/api/src/middleware/requestId.ts) attaches `X-Request-Id` to every response and emits it on Sentry events for correlation.
- `helmet()` enforces CSP (script-src whitelists CDN sources we use), HSTS (1 year, includeSubDomains, preload), `referrerPolicy: strict-origin-when-cross-origin`.
- `compression()` gzips responses.
- `express.json({ limit: '50mb' })` for large CIM/financial uploads.

## Secrets and PII

- [`services/encryption.ts`](../../apps/api/src/services/encryption.ts) — symmetric encryption helper for sensitive fields at rest. Uses `DATA_ENCRYPTION_KEY`.
- Never log full request bodies. Logging helpers in [`utils/logger.ts`](../../apps/api/src/utils/logger.ts) accept structured fields and redact known sensitive keys.
- Audit-relevant operations write to `AuditLog` with severity (`INFO`, `WARNING`, `ERROR`, `CRITICAL`).
- Firm Research Agent: SSRF prevention in [`utils/urlHelpers.ts`](../../apps/api/src/utils/urlHelpers.ts), no PII surfaced from LinkedIn scrapes.

## Error surface

Custom error classes from [`middleware/errorHandler.ts`](../../apps/api/src/middleware/errorHandler.ts):

| Class | Status |
| --- | --- |
| `ValidationError` | 400 |
| `UnauthorizedError` | 401 |
| `ForbiddenError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |

The global handler converts to `{ error, code, requestId }` JSON. Sentry integration is set up via `Sentry.setupExpressErrorHandler(app)` before the custom handler.

**Never throw raw `Error` from a route** — pick the right class so the status code is correct and the global handler can handle it.

## Secrets management

| Env var | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_URL` | DB endpoint | yes |
| `SUPABASE_ANON_KEY` | Public key | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only — never reach the browser | yes (server) |
| `DATA_ENCRYPTION_KEY` | At-rest encryption | prod |
| `OPENAI_API_KEY` | AI features | optional |
| `GEMINI_API_KEY` | Alt LLM | optional |
| `ANTHROPIC_API_KEY` | Optional Claude | optional |
| `AZURE_DI_KEY` / `AZURE_DI_ENDPOINT` | Doc Intelligence | optional |
| `LLAMA_CLOUD_API_KEY` | Deep PDF parser | optional |
| `APIFY_API_TOKEN` | Firm Research Agent web search | optional |
| `RESEND_API_KEY` | Email | prod |
| `SENTRY_DSN` | Error tracking | prod |
| `ALLOWED_ORIGINS` | Extra CORS origins | dev/preview |

Anything missing in production fires a `log.warn` on boot but does not block startup, so the app degrades gracefully.

## Things you must not do

- Don't bypass `orgMiddleware` for "just one quick endpoint". The integration test suite will catch you.
- Don't log JWTs, API keys, encryption keys, or full PII payloads.
- Don't use `--no-verify` on commits to skip pre-commit hooks. Investigate the failure instead.
- Don't add a Supabase service-role-key call client-side. The service role bypasses RLS.
- Don't re-introduce compound `extractionSource` values like `'gpt4o-excel'`. The DB CHECK rejects them.
- Don't return 403 for cross-org access. 404 — always.

# Deal Scorecard + Go/No-Go — Design Spec

## Problem

Deal filtering — not analysis — is the #1 time sink for the beachhead segment (independent sponsors, searchers, small funds). Evidence from the demo-call research (`.planning/demo-research/demo-calls.md`): Martin (M14) — one searcher reviewed 1,700+ companies in month one, and called a two-layer deal scorecard "the most actionable suggestion of any call"; Daniel (M4) — sees 50 teasers/week, wants a go/no-go vs firm criteria with a reason; Max (M16) — criteria-as-filter landed well. Today PE OS scores nothing: every deal in the pipeline looks equally worth attention.

## Goals

- Every deal can be scored against two layers: **general quality** (recurring revenue, margins, customer concentration, CapEx intensity, QoE/red-flag signals) and **thesis fit** (the firm's own criteria: sectors in/out, size bounds, hard exclusions, free-text thesis).
- Output is a typed verdict, not prose: overall score /100, `GO | NO_GO | BORDERLINE`, per-layer sub-scores, and concrete criteria hits/misses ("outside size range: $28M vs your $5–15M max").
- Firms edit their criteria in Settings; the firm research agent's existing `firmProfile` seeds sensible defaults when present.
- Scores surface where filtering happens: badge on pipeline cards, full panel on the deal page.

## Non-Goals

- **Reactivation triggers** (auto re-score passed deals when financials update) — deferred; the scoring function is designed to be re-runnable so this becomes a small follow-up, but no dormant-state machinery now.
- **Teaser-only quick-screen upload flow** — scoring operates on deals that exist; deal-intake already turns a teaser into a deal.
- **Per-user criteria** — org-level only.
- **Auto-score on every deal edit** — triggers are: manual button + post-extraction hook only.
- **Scoring backfill for existing deals** — no batch job; deals get scored when a user asks or when extraction completes.

## Design

### 4.1 Criteria model — `Organization.settings.dealCriteria`

Stored in the existing `Organization.settings` JSONB (same pattern as `firmProfile`; **no migration for criteria**). Shape:

```ts
interface DealCriteria {
  sectorsInclude: string[];      // empty = any
  sectorsExclude: string[];
  dealSizeMin: number | null;    // $M
  dealSizeMax: number | null;
  revenueMin: number | null;
  revenueMax: number | null;
  ebitdaMin: number | null;
  hardExclusions: string[];      // e.g. ["startups", "turnarounds"]
  thesis: string;                // free text
}
```

Read/write via the existing organizations settings route pattern. When `settings.firmProfile` exists (research agent output) and `dealCriteria` doesn't, the criteria editor pre-fills from it (sectors/check-size fields) — seeding at read time in the UI, not a data migration.

### 4.2 Scoring engine — `services/agents/dealScorecard/`

One module, one exported function:

```ts
scoreDeal(dealId: string, orgId: string): Promise<Scorecard>
```

- Gathers: deal row (metadata, deal-level financial metrics), active `FinancialStatement` rows, red-flag/QoE output via the existing `analysis` services when financials exist, and the org's `dealCriteria`.
- One `trackedClaudeMessage()` call (Phase 1 client): `operation: 'deal_scorecard'`, `role: 'chat'`, hand-written JSON `outputSchema` (same convention as Phase 2-C's critique schema — no Zod-to-JSON-schema, this repo's Zod can't).
- Bounded by the same `AbortController` + `Promise.race` timeout pattern as other single-call agents (30s default, env-overridable).
- Returns and persists the typed verdict.

Scorecard shape (also the structured-output schema):

```ts
interface Scorecard {
  overallScore: number;          // 0-100
  verdict: 'GO' | 'NO_GO' | 'BORDERLINE';
  qualityScore: number;          // 0-100, layer 1
  thesisFitScore: number;        // 0-100, layer 2
  reasons: Array<{ kind: 'hit' | 'miss' | 'flag'; text: string }>;
  scoredAt: string;              // ISO
  model: string;                 // served model
}
```

Prompting rules: score ONLY from provided data — missing data lowers confidence and is said explicitly in a reason ("no extracted financials yet — quality score is metadata-only"), never invented (the Julian/M12 grounding lesson). `NO_GO` requires at least one concrete `miss` reason tied to a criterion.

### 4.3 Persistence — one new column

`Deal.scorecard` JSONB, nullable. One-line migration SQL file (`apps/api/scorecard-migration.sql`), and per the standing gotcha (Supabase migrations are manual — Vercel does not run SQL): documented as a manual deploy step, endpoint degrades gracefully (500→clear error) if the column is missing.

### 4.4 API

- `POST /api/deals/:dealId/scorecard` — runs `scoreDeal`, persists, returns the scorecard. Org-scoped via existing `verifyDealAccess`/`getOrgId` patterns, rate-limited under `aiLimiter`.
- Criteria read/write rides the existing organization-settings endpoints (`PATCH /api/organizations/me` pattern) — no new criteria routes if the existing settings route accepts a `settings.dealCriteria` patch; otherwise a minimal `GET/PUT /api/organizations/criteria` pair.
- Post-extraction hook: where financial extraction completes and the deal has org criteria configured, fire-and-forget `scoreDeal` (never blocks or fails the extraction response).

### 4.5 Frontend

- **Pipeline badge** (`deals` list cards): compact colored chip — green `GO xx`, red `NO-GO xx`, amber `xx` for borderline; nothing rendered when unscored. Banker palette, not traffic-light saturation.
- **Deal page panel**: verdict header, two layer sub-scores, reasons list (hits/misses/flags with icons), "Score deal" / "Re-score" button, scored-at timestamp.
- **Settings → Investment Criteria**: form matching the `DealCriteria` shape (multi-select sectors, numeric bounds, exclusions tags, thesis textarea), firmProfile pre-fill note when seeded.

### 4.6 Branch/base

Stacked on `feat/phase1-ai-core` (founder decision this session — same sequencing call as made for the prior wedge design): needs `trackedClaudeMessage` + structured output. Worktree `.worktrees/deal-scorecard`, branch `feat/deal-scorecard`. Known trade-off, flagged: this is the 5th branch dependent on unmerged PR #87; merge risk compounds and the rollout plan (merge chain → migrations → verify → flags) should follow soon after this ships.

## Testing

TDD per task, mocked `trackedClaudeMessage`:
- Engine: criteria + financials → schema-shaped verdict persisted; missing-financials path (metadata-only, reason present); NO_GO includes a criterion-tied miss; timeout/failure → clean error, nothing persisted.
- Route: org-scoping (cross-org 404), rate-limit tier, missing-column graceful error, happy path returns persisted scorecard.
- Post-extraction hook: fires when criteria exist, silent no-op when not, never fails the extraction response.
- Frontend: badge render states (GO/NO_GO/BORDERLINE/unscored), panel reasons rendering, criteria form round-trip.

## Sequencing

1. Criteria model + settings read/write + Settings UI.
2. `scoreDeal` engine + schema + migration file + tests.
3. Route + post-extraction hook + tests.
4. Pipeline badge + deal-page panel + tests.
5. Manual verification (same standing caveat: no credentials in sandbox — document the gap; real run needs founder's environment).

No feature flag: additive feature, nothing existing changes behavior; rollback is `git revert`. The only deploy coupling is the manual `Deal.scorecard` column migration.

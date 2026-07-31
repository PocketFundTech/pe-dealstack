# Phase 1 — Claude Extraction Engine Rollout Checklist

Everything below is a manual/operator action. `EXTRACTION_ENGINE` defaults to
`legacy` — none of this is required for the branch to merge safely; it's
required before flipping the flag anywhere.

## 1. Database migration (required before flag flip)

Run `apps/api/phase1-claude-extraction-migration.sql` manually in the
Supabase SQL editor — Vercel deploys code but never runs SQL.

Verify afterward:
```sql
SELECT model FROM "ModelPrice" WHERE provider='anthropic';
-- expect 4 rows: claude-fable-5, claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5

SELECT conname FROM pg_constraint
WHERE conrelid = '"FinancialStatement"'::regclass AND contype = 'c';
-- expect exactly one check constraint on extractionSource, including 'claude'
```

**If this migration is skipped**, every claude-sourced extraction will fail
to store silently — `runDeepPass` logs and continues past a failed upsert,
so the agent still reports `status: 'completed'` with `periodsStored: 0`.
Watch for this specifically during the first flag-flip test.

## 2. Confirm Anthropic org data retention

Claude Fable 5 (the extraction default) requires the org to be on **≥30-day
data retention** — every request 400s otherwise. Check in the Anthropic
Console before flipping the flag anywhere.

## 3. Run the bake-off on real documents

Collect 5-10 representative CIMs/financial PDFs + 2-3 Excel packages
(not committed to the repo). Run:

```bash
cd apps/api
npx tsx scripts/extraction-bakeoff.ts <folder>
```

**Acceptance gate:** `claude-fable-5` validator pass rate ≥ legacy (hard
gate). Cost is reported, not gated — compare fable-5 vs opus-4-8 for the
model-choice decision.

**Caveat on the comparison:** the bake-off's "legacy" baseline is bare
`pdf-parse` + `classifyFinancials` — it does not include LlamaParse, Vision
fallback, the verify-node correction pass, or the self-correct loop that the
full legacy pipeline has. The gate can look easier to clear than an
apples-to-apples comparison against the FULL legacy pipeline would be.
Interpret the numbers with that in mind, not as a strict like-for-like.

## 4. Flip the flag

Set `EXTRACTION_ENGINE=claude` in Vercel env, deploy.

**Immediately after flipping, on the first real document:**
- Confirm `periodsStored > 0` on at least one extraction (catches a missed
  migration — see §1).
- Watch `/internal/usage` for `financial_extraction` events with provider
  `anthropic` and the expected model.
- Compare the agent's `durationMs`/timing against
  `FINANCIAL_AGENT_TIMEOUT_MS` (120s default, in
  `financialAgent/index.ts`) — the claude engine runs one or two long serial
  calls over a whole document rather than the legacy pipeline's
  chunked-parallel calls; confirm the existing timeout budget is still
  comfortable using the bake-off's recorded `durationMs` numbers.

## 5. Soak period

Two weeks in production with the flag on, per the original design spec
decision (2026-07-11), before any legacy code is deleted.

## 6. Post-soak cleanup (separate follow-up, not part of this plan)

After the soak period, a follow-up plan should:
- Delete `azureDocIntelligence.ts`, `llamaParse.ts`, `visionExtractor.ts`,
  `pdfExtractor.ts`, and the legacy branches of `extractNode.ts`,
  `verifyNode.ts`, `crossVerifyNode.ts`, `selfCorrectNode.ts`.
- Drop dependencies `@azure/ai-form-recognizer`, `@llamaindex/cloud`.
- Migrate the ~40 non-extraction LLM call sites (memos, insights, emails,
  deal chat) from the legacy `llm.ts`/`openai.ts` layer onto
  `services/ai/client.ts` — explicitly out of scope for Phase 1.

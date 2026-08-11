# Financial-extraction eval harness

Makes extraction **quality** measurable so prompt/model/few-shot changes are
judged by a scored delta instead of eyeballing one deal. This is the workflow
the extraction roadmap calls for: **eval + few-shot bank first, not more blind
prompt patches.**

## Why it exists

The 2026-07-03 InstateMe run produced **14 statements for 4 real periods**:
- 4 enrollment cohorts (`Fall 2026`, `Spring 2027`, …) emitted as fiscal periods
- the same year duplicated (`2024`, `FY2024`; `2025`, `FY2025`; `2023`, `FY2023`)
- a spurious `2026` HISTORICAL double-counting the `2026E` projection

The values were right; the **period axis** was corrupted. The scorer turns those
symptoms into numbers: `phantomPeriods`, `duplicatePeriods`, `extraPeriods`,
`periodRecall`, `periodTypeAccuracy`, `lineItemCoverage`.

## Files

| File | Role |
|---|---|
| `types.ts` | `GoldenCase`, `ScoredPeriod`, `ScoreResult` (mirror the live `ClassificationResult`) |
| `score.ts` | Pure deterministic scorer + `flattenResult()` / `formatScoreLine()` |
| `cases/instateme.ts` | First golden case + the captured buggy output used as a test fixture |
| `fewshot.ts` | Period-hygiene rules + few-shot exemplars; `buildPeriodHygieneGuidance()` |
| `runner.ts` | `npm run eval:extraction` — scores captured baselines, runs the live model when a source doc + API key exist |

The scorer is unit-tested in `tests/extraction-evals.test.ts` (runs in CI, no
LLM): it proves the harness flags the real InstateMe defects and passes a
known-correct extraction.

## Run

```bash
cd apps/api
npm run eval:extraction     # scores the captured InstateMe baseline (no key needed)
npm test -- extraction-evals # the CI gate (deterministic scorer)
```

## Loop for fixing an extraction-quality bug

1. **Capture** the bad output as a golden case + `captured` fixture; add the
   correct `expected` periods and `forbiddenPeriodPatterns`.
2. **Baseline**: `npm run eval:extraction` → confirm the scorer flags it.
3. **Guidance**: extend `fewshot.ts` (rules + exemplars).
4. **Measure**: add the source doc as `sourceText`, run the live model
   `baseline` vs `with-hygiene`, keep the guidance only if the score improves.
5. **Ship**: once validated, pass `buildPeriodHygieneGuidance()` as
   `buildExtractionPrompt({ extraGuidance })` at the classifier call sites
   (`financialClassifier.ts`, `claudeFinancialClassifier.ts`). Until then the
   prompt is byte-for-byte unchanged (the hook is opt-in).

## Status

- ✅ Scorer + InstateMe golden case + fixture (deterministic, CI-gated)
- ✅ Period-hygiene few-shot bank + opt-in prompt hook (`extraGuidance`)
- ✅ Deterministic pre-fix already shipped: `FY2024`/`2024` collapse in the normalizer
- ⏳ Live model runs need the InstateMe source doc added as `sourceText` + an API key (run with the tester's key)
- ⏳ Flip `buildPeriodHygieneGuidance()` on in production once the live delta is confirmed

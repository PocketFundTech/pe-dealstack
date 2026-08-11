/**
 * Extraction eval runner.  `npm run eval:extraction`
 * ==================================================
 *
 * Scores golden cases and prints a report. Two modes per case:
 *   - captured: score a captured ScoredPeriod[] (no LLM) — a baseline snapshot.
 *   - live: run classifyFinancials() on source text (+ the same normalizer
 *     dedup production uses), with and without the period-hygiene guidance,
 *     and score both so the few-shot delta is measurable. Requires an API key
 *     and a `sourceText`; skipped otherwise.
 *
 * The deterministic scorer is unit-tested in tests/extraction-evals.test.ts;
 * this runner is the manual/opt-in tool for exercising the real model.
 */
import { classifyFinancials } from '../financialClassifier.js';
import { dedupeStatementPeriods } from '../financialPeriodNormalizer.js';
import { buildPeriodHygieneGuidance } from './fewshot.js';
import { flattenResult, scoreCase, formatScoreLine } from './score.js';
import type { GoldenCase, ScoredPeriod, ScoreResult } from './types.js';
import type { ClassificationResult } from '../financialClassifier.js';
import { INSTATEME_GOLDEN, INSTATEME_BUGGY_OUTPUT } from './cases/instateme.js';

interface EvalCase {
  golden: GoldenCase;
  /** A captured output to score without the LLM (baseline snapshot). */
  captured?: ScoredPeriod[];
  /** Raw document text for a live classifier run. */
  sourceText?: string;
}

const CASES: EvalCase[] = [
  { golden: INSTATEME_GOLDEN, captured: INSTATEME_BUGGY_OUTPUT },
];

/** Apply the same per-statement normalizer/dedup the orchestrator applies. */
function normalizeLikePipeline(result: ClassificationResult): ClassificationResult {
  return {
    ...result,
    statements: result.statements.map((s) => ({
      ...s,
      periods: dedupeStatementPeriods(s.statementType, s.periods),
    })),
  };
}

function printResult(label: string, r: ScoreResult): void {
  console.log(`  ${label}: ${formatScoreLine(r)}`);
  for (const v of r.violations) {
    console.log(`      - [${v.kind}] ${v.period}: ${v.detail}`);
  }
}

async function runLive(c: EvalCase): Promise<void> {
  const text = c.sourceText!;
  for (const [label, guidance] of [
    ['baseline', undefined],
    ['with-hygiene', buildPeriodHygieneGuidance()],
  ] as const) {
    const raw = await classifyFinancials(text, {
      todayIso: c.golden.todayIso,
      extraGuidance: guidance,
    } as Parameters<typeof classifyFinancials>[1]);
    if (!raw) {
      console.log(`  ${label}: classifier returned null (AI disabled or text too short)`);
      continue;
    }
    const flat = flattenResult(normalizeLikePipeline(raw), c.golden.statementType);
    printResult(label, scoreCase(c.golden, flat));
  }
}

async function main(): Promise<void> {
  const aiEnabled = !!(
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENROUTER_API_KEY
  );
  console.log(`\nExtraction eval — ${CASES.length} case(s), AI ${aiEnabled ? 'enabled' : 'DISABLED'}\n`);

  let anyFail = false;
  for (const c of CASES) {
    console.log(`▸ ${c.golden.id} — ${c.golden.description}`);

    if (c.captured) {
      const r = scoreCase(c.golden, c.captured);
      printResult('captured', r);
      // A captured baseline snapshot is informational; do not gate CI on it.
    }

    if (c.sourceText && aiEnabled) {
      await runLive(c);
    } else if (c.sourceText) {
      console.log('  live: skipped (no API key)');
    } else {
      console.log('  live: skipped (no sourceText — add the source doc to run the model)');
    }
    console.log('');
  }

  // Exit non-zero only if a case exposed a regression we chose to gate on.
  // (Currently informational; wire thresholds here when live cases land.)
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('eval runner failed:', err);
  process.exit(1);
});

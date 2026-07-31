/**
 * Extraction bake-off harness (Phase 1 acceptance gate, spec §3.3).
 *
 * Usage:
 *   cd apps/api
 *   npx tsx scripts/extraction-bakeoff.ts <dir-with-pdfs-and-xlsx> [--models claude-fable-5,claude-opus-4-8] [--skip-legacy]
 *
 * For each document, runs:
 *   - legacy: pdf-parse/excel text → classifyFinancials (needs OPENAI_API_KEY or OPENROUTER_API_KEY)
 *   - claude engine once per model in --models (needs ANTHROPIC_API_KEY)
 * and reports: statements/periods found, deterministic validator errors,
 * duration, token usage + cost. Writes bakeoff-results-<timestamp>.md.
 *
 * Hard gate (spec): fable-5 validator pass rate ≥ legacy. Cost is reported,
 * not gated.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import 'dotenv/config';

const PRICES: Record<string, { in: number; out: number }> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

interface RunResult {
  engine: string;
  file: string;
  ok: boolean;
  statements: number;
  periods: number;
  validatorErrors: number;
  validatorWarnings: number;
  overallPassed: boolean;
  durationMs: number;
  costUsd: number | null;
  note: string;
}

function costFor(model: string, inTok: number, outTok: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: npx tsx scripts/extraction-bakeoff.ts <dir> [--models m1,m2] [--skip-legacy]');
    process.exit(1);
  }
  const modelsArg = args.find((a) => a.startsWith('--models='))?.split('=')[1];
  const models = (modelsArg ?? 'claude-fable-5,claude-opus-4-8').split(',').map((m) => m.trim());
  const skipLegacy = args.includes('--skip-legacy');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required');
    process.exit(1);
  }
  if (!skipLegacy && !process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.error('Legacy engine needs OPENAI_API_KEY or OPENROUTER_API_KEY (or pass --skip-legacy)');
    process.exit(1);
  }

  const { validateStatements } = await import('../src/services/financialValidator.js');
  const { extractWithClaude } = await import('../src/services/extraction/claudeEngine.js');

  const files = readdirSync(dir).filter((f) => ['.pdf', '.xlsx', '.xls'].includes(extname(f).toLowerCase()));
  if (files.length === 0) {
    console.error(`No .pdf/.xlsx files in ${dir}`);
    process.exit(1);
  }
  console.log(`Bake-off: ${files.length} document(s), engines: ${skipLegacy ? '' : 'legacy, '}${models.join(', ')}\n`);

  const results: RunResult[] = [];

  const summarize = (
    engine: string,
    file: string,
    classification: { statements: Array<{ periods: unknown[] }> } | null,
    durationMs: number,
    costUsd: number | null,
    note = '',
  ): RunResult => {
    if (!classification || classification.statements.length === 0) {
      return { engine, file, ok: false, statements: 0, periods: 0, validatorErrors: 0, validatorWarnings: 0, overallPassed: false, durationMs, costUsd, note: note || 'no statements' };
    }
    const v = validateStatements(classification.statements as never);
    return {
      engine, file, ok: true,
      statements: classification.statements.length,
      periods: classification.statements.reduce((n, s) => n + s.periods.length, 0),
      validatorErrors: v.errorCount,
      validatorWarnings: v.warningCount,
      overallPassed: v.overallPassed,
      durationMs, costUsd, note,
    };
  };

  for (const file of files) {
    const buffer = readFileSync(join(dir, file));
    const fileType: 'pdf' | 'excel' = extname(file).toLowerCase() === '.pdf' ? 'pdf' : 'excel';

    if (!skipLegacy) {
      process.stdout.write(`  [legacy] ${file} ... `);
      const t0 = Date.now();
      try {
        let text: string;
        if (fileType === 'excel') {
          const { extractTextFromExcel } = await import('../src/services/excelFinancialExtractor.js');
          text = extractTextFromExcel(buffer);
        } else {
          const { createRequire } = await import('node:module');
          const require = createRequire(import.meta.url);
          const pdfParse = require('pdf-parse');
          text = (await pdfParse(buffer)).text ?? '';
        }
        const { classifyFinancials } = await import('../src/services/financialClassifier.js');
        const classification = await classifyFinancials(text);
        results.push(summarize('legacy', file, classification, Date.now() - t0, null));
        console.log('done');
      } catch (err) {
        results.push(summarize('legacy', file, null, Date.now() - t0, null, String(err)));
        console.log('ERROR');
      }
    }

    for (const model of models) {
      process.stdout.write(`  [${model}] ${file} ... `);
      process.env.AI_EXTRACTION_MODEL = model;
      const t0 = Date.now();
      try {
        const out = await extractWithClaude({ fileBuffer: buffer, fileName: file, fileType });
        const cost = out ? costFor(model, out.usage.inputTokens, out.usage.outputTokens) : null;
        results.push(summarize(model, file, out?.classification ?? null, Date.now() - t0, cost, out?.repairUsed ? 'repair pass used' : ''));
        console.log('done');
      } catch (err) {
        results.push(summarize(model, file, null, Date.now() - t0, null, String(err)));
        console.log('ERROR');
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────
  const engines = [...new Set(results.map((r) => r.engine))];
  const lines: string[] = ['# Extraction Bake-off Results', '', `Documents: ${files.length}`, ''];
  lines.push('| Engine | OK | Stmts | Periods | Validator pass | Errors | Avg ms | Total cost |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const engine of engines) {
    const rs = results.filter((r) => r.engine === engine);
    const okCount = rs.filter((r) => r.ok).length;
    const passCount = rs.filter((r) => r.overallPassed).length;
    const totalCost = rs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    const avgMs = Math.round(rs.reduce((n, r) => n + r.durationMs, 0) / rs.length);
    lines.push(
      `| ${engine} | ${okCount}/${rs.length} | ${rs.reduce((n, r) => n + r.statements, 0)} | ${rs.reduce((n, r) => n + r.periods, 0)} | ${passCount}/${rs.length} | ${rs.reduce((n, r) => n + r.validatorErrors, 0)} | ${avgMs} | ${engine === 'legacy' ? 'n/a (not metered here)' : `$${totalCost.toFixed(3)}`} |`,
    );
  }
  lines.push('', '## Per-document detail', '');
  lines.push('| File | Engine | OK | Stmts | Periods | Errors | Warnings | ms | Cost | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.file} | ${r.engine} | ${r.ok ? '✓' : '✗'} | ${r.statements} | ${r.periods} | ${r.validatorErrors} | ${r.validatorWarnings} | ${r.durationMs} | ${r.costUsd === null ? '—' : `$${r.costUsd.toFixed(3)}`} | ${r.note} |`);
  }

  const outPath = `bakeoff-results-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(outPath, lines.join('\n'));
  console.log(`\n${lines.slice(4, 4 + engines.length + 2).join('\n')}\n\nFull report: apps/api/${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Financial Analysis Service — Entry Point
 * Re-exports all types and provides the main analyzeFinancials function.
 */

import { log } from '../../utils/logger.js';
import { AnalysisResult } from './types.js';
import { prepareData, pickAnalysisCurrency } from './helpers.js';
import { computeQoEFlags, computeQoEScore, generateQoESummary } from './qoeAnalysis.js';
import { computeRatios, computeDuPont } from './ratioAnalysis.js';
import {
  computeEBITDABridge, computeRevenueQuality, computeCashFlowAnalysis,
  computeWorkingCapital, computeCostStructure, computeWorkforceMetrics,
} from './operationalAnalysis.js';
import { computeDebtCapacity, computeLBOScreen } from './debtAndLBO.js';
import { computeRedFlags } from './redFlags.js';
import { computeCashFlowRedFlags, computeCashFlowQoEFlags } from './cashFlowFlags.js';
import {
  computeConcentrationRedFlags, computeConcentrationQoEFlags, type ConcentrationFacts,
} from './customerConcentrationFlags.js';

// Re-export all types
export type {
  QoEFlag, RatioGroup, Ratio, EBITDABridge, RevenueQuality,
  CashFlowAnalysis, WorkingCapital, CostStructure, DebtCapacity,
  LBOScreen, RedFlag, WorkforceMetrics, AnalysisResult, DuPontDecomposition,
} from './types.js';
export type { ConcentrationFacts } from './customerConcentrationFlags.js';

export interface AnalyzeOptions {
  /**
   * Customer concentration / related-party facts read from the deal's
   * documents (customerConcentrationReader.ts — fix plan F1 part 2).
   * Omitted or null → no document-derived flags.
   */
  concentration?: ConcentrationFacts | null;
}

export async function analyzeFinancials(dealId: string, rows: any[], options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  if (!rows || rows.length === 0) {
    return { hasData: false, dealId, periods: [], qoe: { score: 0, flags: [], summary: 'No financial data available.' }, ratios: [], analyzedAt: new Date().toISOString() } as any;
  }
  log.info('Starting financial analysis', { dealId, rowCount: rows.length });

  // One currency only — mixed currencies used to be added together.
  const single = pickAnalysisCurrency(rows);
  const data = prepareData(single.rows);

  // All analysis modules read from `data` (immutable) and write to independent outputs.
  // Group into parallel batches for throughput:
  //   Group A: QoE, ratios, DuPont (income statement focused)
  //   Group B: EBITDA bridge, revenue quality, cost structure (income statement trends)
  //   Group C: Cash flow analysis, working capital (CF + balance sheet)
  //   Group D: Debt capacity, LBO screen, workforce, red flags (cross-statement)
  const [
    [flags, ratios, duPont],
    [ebitdaBridge, revenueQuality, costStructure],
    [cashFlowAnalysis, workingCapital],
    [debtCapacity, lboScreen, workforceMetrics, redFlags],
  ] = await Promise.all([
    // Group A
    Promise.all([
      // Cash-flow findings (negative FCF, debt-funded capex — fix plan F1) feed QoE too.
      // Customer concentration / related parties (F1 part 2) come from the documents.
      Promise.resolve([
        ...computeQoEFlags(data), ...computeCashFlowQoEFlags(data), ...computeConcentrationQoEFlags(options.concentration),
      ]),
      Promise.resolve(computeRatios(data)),
      Promise.resolve(computeDuPont(data)),
    ]),
    // Group B
    Promise.all([
      Promise.resolve(computeEBITDABridge(data)),
      Promise.resolve(computeRevenueQuality(data)),
      Promise.resolve(computeCostStructure(data)),
    ]),
    // Group C
    Promise.all([
      Promise.resolve(computeCashFlowAnalysis(data)),
      Promise.resolve(computeWorkingCapital(data)),
    ]),
    // Group D
    Promise.all([
      Promise.resolve(computeDebtCapacity(data)),
      Promise.resolve(computeLBOScreen(data)),
      Promise.resolve(computeWorkforceMetrics(data)),
      Promise.resolve([
        ...computeRedFlags(data), ...computeCashFlowRedFlags(data), ...computeConcentrationRedFlags(options.concentration),
      ]),
    ]),
  ]);

  const score = computeQoEScore(flags);
  const summary = generateQoESummary(score, flags);

  log.info('Financial analysis complete', {
    dealId,
    periodsAnalyzed: data.periods.length,
    qoeFlagCount: flags.length,
    redFlagCount: redFlags.length,
    qoeScore: score,
    lboPasses: lboScreen?.passesScreen,
  });

  return {
    qoe: { score, flags, summary },
    ratios,
    duPont,
    ebitdaBridge,
    revenueQuality,
    cashFlowAnalysis,
    workingCapital,
    costStructure,
    debtCapacity,
    lboScreen,
    redFlags,
    workforceMetrics,
    periods: data.periods,
    currency: single.currency,
    ...(single.note ? { currencyNote: single.note } : {}),
    analyzedAt: new Date().toISOString(),
  };
}

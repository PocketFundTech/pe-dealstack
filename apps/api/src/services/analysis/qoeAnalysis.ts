/**
 * Quality of Earnings (QoE) Analysis
 * Computes QoE flags, scoring, and summary for PE due diligence.
 */

import { PreparedData, QoEFlag } from './types.js';
import { li, pctChange, round2, avg, trendDirection, comparablePeriods, ebitdaOf, periodGrowth } from './helpers.js';

export function computeQoEFlags(data: PreparedData): QoEFlag[] {
  const flags: QoEFlag[] = [];
  const { income, balance, cashflow } = data;

  if (data.periods.length < 2) {
    flags.push({
      id: 'insufficient_data',
      severity: 'info',
      category: 'Data Quality',
      title: 'Limited Historical Data',
      detail: `Only ${data.periods.length} historical period(s) available. At least 3 years recommended for thorough QoE analysis.`,
      icon: 'info',
    });
    return flags;
  }

  // Flows (revenue, EBITDA, cash) are only compared across like periods —
  // full years when available — so a partial YTD never reads as a decline.
  const periods = comparablePeriods(data);

  // 1. Revenue Quality Checks
  const revenues = periods.map(p => li(income.get(p) ?? {}, 'revenue'));
  const revenueGrowths: (number | null)[] = [];
  for (let i = 1; i < periods.length; i++) {
    revenueGrowths.push(periodGrowth(data, periods[i - 1], periods[i], revenues[i - 1], revenues[i]));
  }

  const validGrowths = revenueGrowths.filter((g): g is number => g != null);
  if (validGrowths.length >= 2) {
    const avgGrowth = avg(validGrowths)!;
    const stddev = Math.sqrt(avg(validGrowths.map(g => (g - avgGrowth) ** 2))!);
    if (stddev > 15) {
      flags.push({
        id: 'revenue_volatility',
        severity: 'warning',
        category: 'Revenue Quality',
        title: 'Volatile Revenue Growth',
        detail: `Revenue growth varies significantly (±${round2(stddev)}pp). Investigate customer concentration or one-time revenue events.`,
        metric: `±${round2(stddev)}pp`,
        icon: 'trending_flat',
      });
    }
  }

  const latestGrowth = revenueGrowths[revenueGrowths.length - 1];
  if (latestGrowth != null && latestGrowth < -5) {
    flags.push({
      id: 'revenue_decline',
      severity: 'critical',
      category: 'Revenue Quality',
      title: 'Revenue Declining',
      detail: `Revenue dropped ${round2(Math.abs(latestGrowth))}% in the latest period (${periods[periods.length - 1]}). Investigate root cause.`,
      metric: `${round2(latestGrowth)}%`,
      icon: 'trending_down',
    });
  } else if (latestGrowth != null && latestGrowth > 20) {
    flags.push({
      id: 'revenue_strong_growth',
      severity: 'positive',
      category: 'Revenue Quality',
      title: 'Strong Revenue Growth',
      detail: `Revenue grew ${round2(latestGrowth)}% in ${periods[periods.length - 1]}. Verify sustainability and organic vs. acquired growth.`,
      metric: `+${round2(latestGrowth)}%`,
      icon: 'trending_up',
    });
  }

  // 2. EBITDA Adjustments / Quality
  const ebitdas = periods.map(p => ebitdaOf(income.get(p) ?? {}));
  const ebitdaMargins = periods.map((p, i) => {
    const rev = revenues[i];
    const ebitda = ebitdas[i];
    if (rev && ebitda && rev > 0) return (ebitda / rev) * 100;
    return li(income.get(p) ?? {}, 'ebitda_margin_pct');
  });

  const latestMargin = ebitdaMargins[ebitdaMargins.length - 1];
  if (latestMargin != null && latestMargin > 40) {
    flags.push({
      id: 'high_ebitda_margin',
      severity: 'warning',
      category: 'EBITDA Quality',
      title: 'Unusually High EBITDA Margin',
      detail: `EBITDA margin of ${round2(latestMargin)}% is above typical PE targets. May indicate under-investment in SG&A, R&D, or owner adjustments needed.`,
      metric: `${round2(latestMargin)}%`,
      icon: 'warning',
    });
  }

  if (ebitdaMargins.length >= 2) {
    const marginChange = pctChange(
      ebitdaMargins[ebitdaMargins.length - 1],
      ebitdaMargins[0]
    );
    if (marginChange != null && marginChange < -10) {
      flags.push({
        id: 'margin_compression',
        severity: 'critical',
        category: 'EBITDA Quality',
        title: 'Margin Compression',
        detail: `EBITDA margin declined from ${round2(ebitdaMargins[0])}% to ${round2(ebitdaMargins[ebitdaMargins.length - 1])}% over the analysis period. Investigate cost escalation or pricing pressure.`,
        metric: `${round2(marginChange)}%`,
        icon: 'compress',
      });
    } else if (marginChange != null && marginChange > 10) {
      flags.push({
        id: 'margin_expansion',
        severity: 'positive',
        category: 'EBITDA Quality',
        title: 'Margin Expansion',
        detail: `EBITDA margin expanded from ${round2(ebitdaMargins[0])}% to ${round2(ebitdaMargins[ebitdaMargins.length - 1])}%. Indicates operational leverage or pricing power.`,
        metric: `+${round2(marginChange)}%`,
        icon: 'expand',
      });
    }
  }

  // EBITDA vs Operating Cash Flow divergence
  const latestEbitda = ebitdas[ebitdas.length - 1];
  const latestOCF = li(cashflow.get(periods[periods.length - 1]) ?? {}, 'operating_cf');
  if (latestEbitda != null && latestOCF != null && latestEbitda > 0) {
    const cashConversion = (latestOCF / latestEbitda) * 100;
    if (cashConversion < 60) {
      flags.push({
        id: 'low_cash_conversion',
        severity: 'critical',
        category: 'Cash Quality',
        title: 'Poor Cash Conversion',
        detail: `Operating cash flow is only ${round2(cashConversion)}% of EBITDA. Investigate working capital build-up, non-cash revenue, or aggressive accruals.`,
        metric: `${round2(cashConversion)}%`,
        icon: 'money_off',
      });
    } else if (cashConversion > 90) {
      flags.push({
        id: 'strong_cash_conversion',
        severity: 'positive',
        category: 'Cash Quality',
        title: 'Strong Cash Conversion',
        detail: `Operating cash flow is ${round2(cashConversion)}% of EBITDA. Healthy cash generation supports debt service and growth.`,
        metric: `${round2(cashConversion)}%`,
        icon: 'payments',
      });
    }
  }

  // 3. Working Capital Trends
  for (let i = 1; i < periods.length; i++) {
    const prevBal = balance.get(periods[i - 1]);
    const curBal = balance.get(periods[i]);
    const curInc = income.get(periods[i]);
    if (!prevBal || !curBal || !curInc) continue;

    const prevAR = li(prevBal, 'accounts_receivable');
    const curAR = li(curBal, 'accounts_receivable');
    const curRev = li(curInc, 'revenue');

    if (curAR != null && prevAR != null && curRev != null && curRev > 0) {
      const arGrowth = pctChange(curAR, prevAR);
      const revGrowth = pctChange(curRev, revenues[i - 1]);
      if (arGrowth != null && revGrowth != null && arGrowth > revGrowth + 15) {
        flags.push({
          id: `ar_outpacing_revenue_${periods[i]}`,
          severity: 'warning',
          category: 'Working Capital',
          title: `AR Growing Faster Than Revenue (${periods[i]})`,
          detail: `Accounts receivable grew ${round2(arGrowth)}% vs revenue growth of ${round2(revGrowth)}%. May indicate collection issues or channel stuffing.`,
          metric: `AR +${round2(arGrowth)}%`,
          icon: 'account_balance',
        });
        break;
      }
    }
  }

  // 4. CapEx vs D&A
  for (const p of periods.slice(-2)) {
    const inc = income.get(p);
    const cf = cashflow.get(p);
    if (!inc || !cf) continue;

    const da = li(inc, 'da');
    const capex = li(cf, 'capex');
    if (da != null && capex != null && da > 0) {
      const capexAbs = Math.abs(capex);
      const ratio = capexAbs / da;
      if (ratio < 0.5) {
        flags.push({
          id: `capex_underinvestment_${p}`,
          severity: 'warning',
          category: 'Capital Expenditure',
          title: `Low CapEx vs D&A (${p})`,
          detail: `CapEx ($${round2(capexAbs)}M) is only ${round2(ratio * 100)}% of D&A ($${round2(da)}M). May indicate under-investment or asset-light transition. Verify maintenance CapEx needs.`,
          metric: `${round2(ratio)}x`,
          icon: 'construction',
        });
        break;
      } else if (ratio > 2.5) {
        flags.push({
          id: `capex_heavy_${p}`,
          severity: 'info',
          category: 'Capital Expenditure',
          title: `Heavy CapEx Spend (${p})`,
          detail: `CapEx ($${round2(capexAbs)}M) is ${round2(ratio)}x D&A ($${round2(da)}M). Growth CapEx or capacity expansion underway. Normalize for maintenance CapEx in EBITDA bridge.`,
          metric: `${round2(ratio)}x`,
          icon: 'precision_manufacturing',
        });
        break;
      }
    }
  }

  // 5. Leverage Check
  const latestBal = balance.get(periods[periods.length - 1]);
  if (latestBal && latestEbitda != null && latestEbitda > 0) {
    const totalDebt = (li(latestBal, 'short_term_debt') ?? 0) + (li(latestBal, 'long_term_debt') ?? 0);
    const cash = li(latestBal, 'cash') ?? 0;
    const netDebt = totalDebt - cash;
    const leverage = netDebt / latestEbitda;

    if (leverage > 4) {
      flags.push({
        id: 'high_leverage',
        severity: 'critical',
        category: 'Leverage',
        title: 'High Net Debt / EBITDA',
        detail: `Net Debt / EBITDA of ${round2(leverage)}x exceeds typical PE comfort zone (3-4x). Limited debt capacity for LBO financing.`,
        metric: `${round2(leverage)}x`,
        icon: 'trending_up',
      });
    } else if (leverage < 1 && leverage >= 0) {
      flags.push({
        id: 'low_leverage',
        severity: 'positive',
        category: 'Leverage',
        title: 'Conservative Leverage',
        detail: `Net Debt / EBITDA of ${round2(leverage)}x provides significant debt capacity for acquisition financing.`,
        metric: `${round2(leverage)}x`,
        icon: 'shield',
      });
    }
  }

  // 6. SG&A as % of Revenue trend
  const sgaPcts = periods.map((p, i) => {
    const sga = li(income.get(p) ?? {}, 'sga');
    const rev = revenues[i];
    if (sga != null && rev != null && rev > 0) return (sga / rev) * 100;
    return null;
  });
  const sgaTrend = trendDirection(sgaPcts);
  if (sgaTrend === 'improving') {
    const latestSga = sgaPcts[sgaPcts.length - 1];
    if (latestSga != null) {
      flags.push({
        id: 'sga_leverage',
        severity: 'positive',
        category: 'Cost Structure',
        title: 'Operating Leverage in SG&A',
        detail: `SG&A as % of revenue declining to ${round2(latestSga)}%. Indicates scalable cost structure.`,
        metric: `${round2(latestSga)}%`,
        icon: 'speed',
      });
    }
  }

  return flags;
}

export function computeQoEScore(flags: QoEFlag[]): number {
  let score = 75;
  for (const flag of flags) {
    if (flag.severity === 'critical') score -= 12;
    else if (flag.severity === 'warning') score -= 5;
    else if (flag.severity === 'positive') score += 5;
  }
  return Math.max(0, Math.min(100, score));
}

export function generateQoESummary(score: number, flags: QoEFlag[]): string {
  const critical = flags.filter(f => f.severity === 'critical').length;
  const warnings = flags.filter(f => f.severity === 'warning').length;
  const positive = flags.filter(f => f.severity === 'positive').length;

  if (critical >= 3) return 'Significant quality of earnings concerns identified. Multiple critical issues require thorough due diligence investigation before proceeding.';
  if (critical >= 1) return `${critical} critical issue(s) and ${warnings} warning(s) identified. Focused diligence recommended on flagged areas.`;
  if (warnings >= 3) return 'Several areas warrant attention during due diligence, though no critical issues were found. Overall earnings quality appears moderate.';
  if (positive >= 3 && critical === 0) return 'Strong quality of earnings profile. Consistent growth, healthy margins, and good cash conversion support the investment thesis.';
  return 'Earnings quality appears reasonable based on available data. Standard due diligence procedures recommended.';
}


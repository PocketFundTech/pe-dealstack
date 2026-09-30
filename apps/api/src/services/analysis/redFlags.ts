/**
 * Red Flag Deep Detection
 * Revenue recognition anomalies, expense capitalization, asset quality,
 * trend extrapolation, inventory buildup, and equity erosion.
 */

import { PreparedData, RedFlag } from './types.js';
import { li, pctChange, round2, comparablePeriods, ebitdaOf } from './helpers.js';

export function computeRedFlags(data: PreparedData): RedFlag[] {
  const flags: RedFlag[] = [];
  const { income, balance, cashflow } = data;
  // Pairwise checks compare like periods only (never a YTD against a year).
  const periods = comparablePeriods(data);

  if (periods.length < 2) return flags;

  // 3a. Revenue recognition anomalies
  for (let i = 1; i < periods.length; i++) {
    const prevInc = income.get(periods[i - 1]) ?? {};
    const curInc = income.get(periods[i]) ?? {};
    const curCf = cashflow.get(periods[i]) ?? {};

    const prevRev = li(prevInc, 'revenue');
    const curRev = li(curInc, 'revenue');
    const curOCF = li(curCf, 'operating_cf');

    if (prevRev != null && curRev != null && curOCF != null && prevRev > 0) {
      const revGrowth = pctChange(curRev, prevRev);
      if (revGrowth != null && revGrowth > 10 && curOCF < (curRev * 0.3)) {
        flags.push({
          id: `revenue_recognition_${periods[i]}`,
          severity: 'critical',
          category: 'Revenue Recognition',
          title: `Revenue Up but Cash Lags (${periods[i]})`,
          detail: `Revenue grew ${round2(revGrowth)}% but operating cash flow is only ${round2((curOCF / curRev) * 100)}% of revenue. Potential revenue recognition concern.`,
          evidence: `Revenue: $${round2(curRev)}M, OCF: $${round2(curOCF)}M`,
          icon: 'gavel',
        });
        break;
      }
    }
  }

  // 3b. Related-party / expense anomalies
  for (let i = 1; i < periods.length; i++) {
    const prevInc = income.get(periods[i - 1]) ?? {};
    const curInc = income.get(periods[i]) ?? {};

    const prevSga = li(prevInc, 'sga');
    const curSga = li(curInc, 'sga');
    const prevRev = li(prevInc, 'revenue');
    const curRev = li(curInc, 'revenue');

    if (prevSga != null && curSga != null && prevRev != null && curRev != null && prevRev > 0 && curRev > 0) {
      const sgaChange = pctChange(curSga, prevSga);
      const revChange = pctChange(curRev, prevRev);

      if (sgaChange != null && revChange != null && sgaChange < -20 && revChange > -5) {
        flags.push({
          id: `expense_shift_${periods[i]}`,
          severity: 'warning',
          category: 'Expense Capitalization',
          title: `SG&A Dropped Sharply (${periods[i]})`,
          detail: `SG&A decreased ${round2(Math.abs(sgaChange!))}% while revenue changed ${round2(revChange)}%. Investigate whether expenses were capitalized or reclassified.`,
          evidence: `SG&A: $${round2(prevSga)}M → $${round2(curSga)}M`,
          icon: 'swap_horiz',
        });
        break;
      }
    }
  }

  // 3c. Balance sheet anomalies — intangibles/goodwill
  for (let i = 1; i < periods.length; i++) {
    const prevBal = balance.get(periods[i - 1]) ?? {};
    const curBal = balance.get(periods[i]) ?? {};

    const prevGoodwill = li(prevBal, 'goodwill') ?? 0;
    const curGoodwill = li(curBal, 'goodwill') ?? 0;
    const prevIntangibles = li(prevBal, 'intangibles') ?? 0;
    const curIntangibles = li(curBal, 'intangibles') ?? 0;
    const curTA = li(curBal, 'total_assets');

    const prevIntTotal = prevGoodwill + prevIntangibles;
    const curIntTotal = curGoodwill + curIntangibles;

    if (curTA != null && curTA > 0 && curIntTotal > 0) {
      const intangiblePct = (curIntTotal / curTA) * 100;
      if (intangiblePct > 50) {
        flags.push({
          id: `high_intangibles_${periods[i]}`,
          severity: 'warning',
          category: 'Asset Quality',
          title: `High Intangible Assets (${periods[i]})`,
          detail: `Goodwill + intangibles are ${round2(intangiblePct)}% of total assets. Impairment risk if acquisition performance disappoints.`,
          evidence: `Intangibles: $${round2(curIntTotal)}M of $${round2(curTA)}M total assets`,
          icon: 'cloud_circle',
        });
        break;
      }
    }

    if (prevIntTotal > 0 && curIntTotal > 0) {
      const intGrowth = pctChange(curIntTotal, prevIntTotal);
      if (intGrowth != null && intGrowth > 50) {
        flags.push({
          id: `intangible_surge_${periods[i]}`,
          severity: 'info',
          category: 'Asset Quality',
          title: `Intangibles Grew ${round2(intGrowth)}% (${periods[i]})`,
          detail: `Significant increase in goodwill/intangibles suggests acquisitions. Verify purchase price allocation and integration progress.`,
          evidence: `Intangibles: $${round2(prevIntTotal)}M → $${round2(curIntTotal)}M`,
          icon: 'add_business',
        });
        break;
      }
    }
  }

  // 3d. Trend extrapolation — margin trajectory
  if (periods.length >= 3) {
    const margins = periods.map(p => {
      const rev = li(income.get(p) ?? {}, 'revenue');
      const ebitda = ebitdaOf(income.get(p) ?? {});
      return rev && ebitda && rev > 0 ? (ebitda / rev) * 100 : null;
    });

    const validMargins = margins.filter((m): m is number => m != null);
    if (validMargins.length >= 3) {
      let declining = 0;
      for (let i = 1; i < validMargins.length; i++) {
        if (validMargins[i] < validMargins[i - 1]) declining++;
      }

      if (declining === validMargins.length - 1) {
        flags.push({
          id: 'consistent_margin_erosion',
          severity: 'critical',
          category: 'Trend Analysis',
          title: 'Consistent Margin Erosion',
          detail: `EBITDA margin has declined in every period: ${validMargins.map(m => round2(m) + '%').join(' → ')}. Structural headwinds may be present.`,
          evidence: `${validMargins.length} consecutive periods of margin decline`,
          icon: 'south_east',
        });
      }
    }
  }

  // Inventory buildup vs revenue
  const latestP = periods[periods.length - 1];
  const prevP = periods.length >= 2 ? periods[periods.length - 2] : null;
  if (prevP) {
    const curBal = balance.get(latestP) ?? {};
    const prevBal = balance.get(prevP) ?? {};
    const curInv = li(curBal, 'inventory');
    const prevInv = li(prevBal, 'inventory');
    const curRev = li(income.get(latestP) ?? {}, 'revenue');
    const prevRev = li(income.get(prevP) ?? {}, 'revenue');

    if (curInv != null && prevInv != null && curRev != null && prevRev != null && prevInv > 0 && prevRev > 0) {
      const invGrowth = pctChange(curInv, prevInv);
      const revGrowth = pctChange(curRev, prevRev);

      if (invGrowth != null && revGrowth != null && invGrowth > revGrowth + 20) {
        flags.push({
          id: 'inventory_buildup',
          severity: 'warning',
          category: 'Working Capital',
          title: 'Inventory Buildup',
          detail: `Inventory grew ${round2(invGrowth)}% vs revenue growth of ${round2(revGrowth)}%. May signal slowing demand or obsolescence risk.`,
          evidence: `Inventory: $${round2(prevInv)}M → $${round2(curInv)}M`,
          icon: 'inventory_2',
        });
      }
    }
  }

  // Equity declining
  if (periods.length >= 2) {
    const firstEq = li(balance.get(periods[0]) ?? {}, 'total_equity');
    const lastEq = li(balance.get(latestP) ?? {}, 'total_equity');
    if (firstEq != null && lastEq != null && firstEq > 0 && lastEq < firstEq * 0.7) {
      flags.push({
        id: 'equity_erosion',
        severity: 'critical',
        category: 'Solvency',
        title: 'Equity Erosion',
        detail: `Total equity declined from $${round2(firstEq)}M to $${round2(lastEq)}M (${round2(pctChange(lastEq, firstEq))}%). Accumulated losses may signal deeper issues.`,
        evidence: `Equity: $${round2(firstEq)}M → $${round2(lastEq)}M`,
        icon: 'trending_down',
      });
    }
  }

  return flags;
}

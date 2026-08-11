import { describe, it, expect } from "vitest";

import {
  analyzeActualDollarSeries,
  medianAbs,
  scaleActualToUnit,
  suggestedMaxExcludingOutliers,
} from "./deal-financials-charts-shared";

// ---------------------------------------------------------------------------
// medianAbs — basic robustness around null / zero / mixed-sign inputs
// ---------------------------------------------------------------------------

describe("medianAbs", () => {
  it("returns null for an empty input", () => {
    expect(medianAbs([])).toBeNull();
  });

  it("returns null when every entry is null or zero", () => {
    expect(medianAbs([null, 0, null, 0])).toBeNull();
  });

  it("ignores zeros and nulls when computing the median", () => {
    // Effective list after filter: [10, 20, 30]; median = 20.
    expect(medianAbs([10, 0, 20, null, 30])).toBe(20);
  });

  it("uses absolute values so signed inputs share a magnitude band", () => {
    // |‑5|, |10|, |‑15| → sorted [5,10,15], median = 10.
    expect(medianAbs([-5, 10, -15])).toBe(10);
  });

  it("returns the average of the two middle entries on an even-length list", () => {
    // Sorted: [1, 2, 3, 4] → median = (2 + 3) / 2 = 2.5.
    expect(medianAbs([1, 2, 3, 4])).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// analyzeActualDollarSeries — the DMpro bug's regression test lives here
// ---------------------------------------------------------------------------

describe("analyzeActualDollarSeries", () => {
  it("flags a row whose value is >1000x the median as an outlier (DMpro bug B2)", () => {
    // Most rows are sub-$10k (sane raw-dollar extraction); one row is
    // $15.6B because it was mis-tagged as MILLIONS. The chart axis would
    // otherwise blow up to $16B and collapse every other bar.
    const series = [1500, 1860, 2100, 287, 15_600_000_000];
    const out = analyzeActualDollarSeries(series);
    expect(out.hasOutlier).toBe(true);
    expect(out.outliers).toEqual([false, false, false, false, true]);
    expect(out.unit).toBe("K"); // median around $1.8k → K
  });

  it("returns no outliers when every value sits within the median's order of magnitude", () => {
    const series = [1_000_000, 1_200_000, 1_500_000, 900_000];
    const out = analyzeActualDollarSeries(series);
    expect(out.hasOutlier).toBe(false);
    expect(out.outliers.every((o) => !o)).toBe(true);
    expect(out.unit).toBe("M");
  });

  it("picks a B-scale unit for a median in the billions", () => {
    const series = [2_000_000_000, 2_500_000_000, 3_000_000_000];
    const out = analyzeActualDollarSeries(series);
    expect(out.unit).toBe("B");
  });

  it("picks 'units' for sub-$1k medians (raw counts / headcount-like signals)", () => {
    const series = [200, 300, 400, 500];
    const out = analyzeActualDollarSeries(series);
    expect(out.unit).toBe("units");
  });

  it("defaults to 'M' and reports no outliers on an empty / all-null series", () => {
    const out = analyzeActualDollarSeries([null, null, null]);
    expect(out.unit).toBe("M");
    expect(out.median).toBeNull();
    expect(out.hasOutlier).toBe(false);
  });

  it("treats null and zero values as non-outliers (they don't sit on the chart)", () => {
    const series = [1000, null, 0, 1200];
    const out = analyzeActualDollarSeries(series);
    expect(out.outliers).toEqual([false, false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// scaleActualToUnit
// ---------------------------------------------------------------------------

describe("scaleActualToUnit", () => {
  it("returns null for null / undefined input", () => {
    expect(scaleActualToUnit(null, "M")).toBeNull();
    expect(scaleActualToUnit(undefined, "M")).toBeNull();
  });

  it("returns the input verbatim when the unit is 'units'", () => {
    expect(scaleActualToUnit(1860, "units")).toBe(1860);
  });

  it("divides by 1k for the K unit", () => {
    expect(scaleActualToUnit(1500, "K")).toBe(1.5);
  });

  it("divides by 1M for the M unit", () => {
    expect(scaleActualToUnit(5_000_000, "M")).toBe(5);
  });

  it("divides by 1B for the B unit", () => {
    expect(scaleActualToUnit(2_500_000_000, "B")).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// suggestedMaxExcludingOutliers
// ---------------------------------------------------------------------------

describe("suggestedMaxExcludingOutliers", () => {
  it("returns null when every entry is null or flagged", () => {
    expect(suggestedMaxExcludingOutliers([null, null], [false, false])).toBeNull();
    expect(suggestedMaxExcludingOutliers([100, 200], [true, true])).toBeNull();
  });

  it("excludes outlier values from the max and adds ~15% headroom", () => {
    const values = [100, 200, 300, 999_999_999];
    const outliers = [false, false, false, true];
    const max = suggestedMaxExcludingOutliers(values, outliers);
    // Largest non-outlier = 300; with headroom = 300 * 1.15 = 345.
    expect(max).toBeCloseTo(345, 5);
  });

  it("uses the full series when no row is flagged", () => {
    const values = [10, 20, 30];
    const outliers = [false, false, false];
    const max = suggestedMaxExcludingOutliers(values, outliers);
    expect(max).toBeCloseTo(30 * 1.15, 5);
  });
});

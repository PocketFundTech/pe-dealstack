import { describe, it, expect } from "vitest";
import { inferPeriodScope, comparePeriodChronologically } from "./deal-financials-period-scope";

describe("period scope with date-range labels (SRM regression)", () => {
  it("classifies FY labels with a trailing range as annual, not monthly", () => {
    expect(inferPeriodScope("FY2023 (Jan - Dec 2023)")).toBe("annual");
    expect(inferPeriodScope("2025 YTD (Jan - Sep 2025)")).toBe("ytd");
    expect(inferPeriodScope("Feb 2026")).toBe("monthly");
    expect(inferPeriodScope("2024")).toBe("annual");
  });

  it("orders SRM periods chronologically", () => {
    const labels = ["2025 YTD (Jan - Sep 2025)", "FY2024 (Jan - Dec 2024)", "2021", "FY2023 (Jan - Dec 2023)"];
    expect([...labels].sort(comparePeriodChronologically)).toEqual([
      "2021", "FY2023 (Jan - Dec 2023)", "FY2024 (Jan - Dec 2024)", "2025 YTD (Jan - Sep 2025)",
    ]);
  });

  it("keeps months in calendar order", () => {
    expect(["Apr-26", "Feb-26", "Jan-26"].sort(comparePeriodChronologically)).toEqual(["Jan-26", "Feb-26", "Apr-26"]);
  });
});

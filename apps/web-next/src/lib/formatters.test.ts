import { describe, it, expect } from "vitest";
import {
  formatCurrency,
  formatFileSize,
  formatFinancialValue,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  getCurrencySymbol,
  getDealDisplayName,
  getInitials,
} from "./formatters";

describe("formatCurrency", () => {
  it("returns em-dash for null/undefined inputs", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
  });

  it("formats USD millions and billions with B/M/K suffix", () => {
    expect(formatCurrency(1500, "USD")).toBe("$1.50B"); // 1500M = 1.5B
    expect(formatCurrency(50, "USD")).toBe("$50.0M");
    expect(formatCurrency(0.5, "USD")).toBe("$500K"); // 0.5M = 500K
  });

  it("uses Crore/Lakh for INR (Indian numbering)", () => {
    // Values are in millions: 10M = 1 Cr, 0.1M = 1 L
    expect(formatCurrency(10, "INR")).toBe("₹1.00Cr");
    expect(formatCurrency(0.5, "INR")).toBe("₹5.00L"); // 0.5M = 5 lakh
  });

  it("defaults to USD when currency omitted", () => {
    expect(formatCurrency(100)).toBe("$100M");
  });
});

describe("formatFinancialValue", () => {
  it("returns em-dash for null/undefined/NaN", () => {
    expect(formatFinancialValue(null)).toBe("—");
    expect(formatFinancialValue(undefined)).toBe("—");
    expect(formatFinancialValue(NaN, "MILLIONS")).toBe("—");
  });

  it("converts MILLIONS to actual dollars and auto-scales (small)", () => {
    // 0.0067 M = $6,700 -> "$6.7K"
    expect(formatFinancialValue(0.0067, "MILLIONS")).toBe("$6.7K");
  });

  it("formats ACTUALS at K range", () => {
    expect(formatFinancialValue(6700, "ACTUALS")).toBe("$6.7K");
  });

  it("treats undefined unitScale as ACTUALS", () => {
    expect(formatFinancialValue(6700)).toBe("$6.7K");
  });

  it("formats THOUSANDS at K", () => {
    expect(formatFinancialValue(53.7, "THOUSANDS")).toBe("$53.7K");
  });

  it("formats BILLIONS at B", () => {
    expect(formatFinancialValue(1.5, "BILLIONS")).toBe("$1.5B");
  });

  it("formats MILLIONS large value at M", () => {
    expect(formatFinancialValue(320, "MILLIONS")).toBe("$320.0M");
  });

  it("auto-scales to B when MILLIONS crosses 1000", () => {
    expect(formatFinancialValue(1500, "MILLIONS")).toBe("$1.5B");
  });

  it("renders raw < 1000 with no suffix", () => {
    expect(formatFinancialValue(650, "ACTUALS")).toBe("$650");
  });

  it("respects currency symbol", () => {
    expect(formatFinancialValue(1.5, "BILLIONS", { currency: "EUR" })).toBe("€1.5B");
  });

  it("uses INR Cr/L scale", () => {
    // 10M actual = 1 Cr
    expect(formatFinancialValue(10, "MILLIONS", { currency: "INR" })).toBe("₹1.0Cr");
    // 500K actual = 5 L
    expect(formatFinancialValue(500, "THOUSANDS", { currency: "INR" })).toBe("₹5.0L");
  });

  it("respects custom precision", () => {
    expect(formatFinancialValue(1.234, "BILLIONS", { precision: 2 })).toBe("$1.23B");
  });

  it("renders negatives with leading minus", () => {
    expect(formatFinancialValue(-2.5, "MILLIONS")).toBe("-$2.5M");
  });
});

describe("formatPercent", () => {
  it("returns em-dash for nullish/NaN", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
  });

  it("formats with default 1 decimal", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
  });

  it("respects custom decimals", () => {
    expect(formatPercent(12.345, 0)).toBe("12%");
  });
});

describe("formatFileSize", () => {
  it("returns em-dash for nullish/zero", () => {
    expect(formatFileSize(null)).toBe("—");
    expect(formatFileSize(undefined)).toBe("—");
    expect(formatFileSize(0)).toBe("—");
  });

  it("scales bytes → KB → MB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1572864)).toBe("1.5 MB"); // 1.5 MB
  });
});

describe("formatNumber", () => {
  it("formats with default 1 decimal place", () => {
    expect(formatNumber(1234.5)).toBe("1,234.5");
  });

  it("respects custom decimal count", () => {
    expect(formatNumber(7, 2)).toBe("7.00");
    expect(formatNumber(7, 0)).toBe("7");
  });
});

describe("formatRelativeTime", () => {
  it("returns em-dash for missing input", () => {
    expect(formatRelativeTime(null)).toBe("—");
    expect(formatRelativeTime(undefined)).toBe("—");
  });

  it("returns 'Just now' for very recent timestamps", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("Just now");
  });

  it("formats minutes ago for 2-minute-old timestamps", () => {
    const past = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe("2 mins ago");
  });

  it("formats hours ago for ~3-hour-old timestamps", () => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(past)).toBe("3 hours ago");
  });
});

describe("getCurrencySymbol", () => {
  it("falls back to $ when no currency provided", () => {
    expect(getCurrencySymbol()).toBe("$");
    expect(getCurrencySymbol(null)).toBe("$");
  });

  it("returns the canonical symbol for known codes", () => {
    expect(getCurrencySymbol("USD")).toBe("$");
    expect(getCurrencySymbol("INR")).toBe("₹");
    expect(getCurrencySymbol("EUR")).toBe("€");
  });

  it("falls back to '<CODE> ' for unknown currencies", () => {
    expect(getCurrencySymbol("XYZ")).toBe("XYZ ");
  });
});

describe("getInitials", () => {
  it("two-arg form picks first letter of each", () => {
    expect(getInitials("John", "Doe")).toBe("JD");
  });

  it("single-arg form splits on spaces", () => {
    expect(getInitials("John Doe")).toBe("JD");
    expect(getInitials("Mary Jane Watson")).toBe("MJ"); // capped at 2
  });

  it("returns '?' for empty/missing input", () => {
    expect(getInitials("")).toBe("?");
    expect(getInitials(null)).toBe("?");
  });
});

describe("getDealDisplayName", () => {
  it("prefers explicit companyName over deal name", () => {
    expect(
      getDealDisplayName({ name: "Project Alpha", companyName: "Acme Co" })
    ).toBe("Acme Co");
  });

  it("extracts a domain-derived name when the value looks like a URL", () => {
    expect(
      getDealDisplayName({ name: "https://www.backlift.com/about" })
    ).toBe("Backlift");
  });

  it("returns the raw name when it isn't a URL", () => {
    expect(getDealDisplayName({ name: "Pocket Fund" })).toBe("Pocket Fund");
  });
});

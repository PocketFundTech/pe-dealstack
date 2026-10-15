import { describe, it, expect } from "vitest";
import { confidenceBand, confidenceReason, headlineTrustGate, reviewItemCount } from "./deal-financials-trust";

const err = (period: string, message = "EBITDA exceeds revenue in 2025") =>
  ({ severity: "error" as const, message, period });
const warn = (period: string) => ({ severity: "warning" as const, message: "w", period });

describe("headlineTrustGate", () => {
  it("gates when an error exists for the cached period", () => {
    expect(headlineTrustGate([err("2025")], "2025")).toEqual({ gated: true, reason: "EBITDA exceeds revenue in 2025" });
  });
  it("does not gate on warnings or info only (CSP case)", () => {
    const checks = [warn("2025"), warn("2025"), { severity: "info" as const, message: "i", period: "2025" }];
    expect(headlineTrustGate(checks, "2025").gated).toBe(false);
  });
  it("does not gate on errors for another period", () => {
    expect(headlineTrustGate([err("2024")], "2025").gated).toBe(false);
  });
  it("does not gate without a cached period or without checks", () => {
    expect(headlineTrustGate([err("2025")], null).gated).toBe(false);
    expect(headlineTrustGate(null, "2025").gated).toBe(false);
  });
  it("matches periods ignoring case/whitespace", () => {
    expect(headlineTrustGate([err(" fy2025 ")], "FY2025").gated).toBe(true);
  });
});

describe("confidence display", () => {
  it("bands at 85 / 60", () => {
    expect(confidenceBand(92)).toBe("green");
    expect(confidenceBand(85)).toBe("green");
    expect(confidenceBand(73)).toBe("amber");
    expect(confidenceBand(60)).toBe("amber");
    expect(confidenceBand(59)).toBe("red");
  });
  it("reason is null when green, count when flags exist", () => {
    expect(confidenceReason(90, 3)).toBeNull();
    expect(confidenceReason(73, 4)).toBe("4 items to review");
    expect(confidenceReason(73, 1)).toBe("1 item to review");
    expect(confidenceReason(50, 0)).toMatch(/source/);
  });
  it("counts only error+warning", () => {
    expect(reviewItemCount([warn("a"), err("a"), { severity: "info", message: "x" }])).toBe(2);
  });
});

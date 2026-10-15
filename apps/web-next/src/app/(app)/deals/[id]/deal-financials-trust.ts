// Pure helpers for the single-confidence-number display and the headline
// trust gate. No React so they are trivially unit-testable.

export interface TrustCheck {
  severity: "error" | "warning" | "info";
  message: string;
  period?: string;
  passed?: boolean;
}

export type ConfidenceBand = "green" | "amber" | "red";

/** green >= 85, amber 60-84, red < 60. */
export function confidenceBand(score: number): ConfidenceBand {
  if (score >= 85) return "green";
  if (score >= 60) return "amber";
  return "red";
}

/** Failed error + warning checks: the "items to review". Info never counts. */
export function reviewItemCount(checks: TrustCheck[] | null | undefined): number {
  return (checks ?? []).filter((c) => c.passed !== true && (c.severity === "error" || c.severity === "warning")).length;
}

/** Plain-language reason shown next to an amber/red score; null when green. */
export function confidenceReason(score: number, itemCount: number): string | null {
  if (confidenceBand(score) === "green") return null;
  if (itemCount > 0) return `${itemCount} item${itemCount === 1 ? "" : "s"} to review`;
  return "Review the extracted figures against the source";
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export interface TrustGate {
  gated: boolean;
  reason: string | null;
}

/**
 * The headline card must never show a number the validator marked as an ERROR
 * for the period the card shows. Warnings/info never gate; errors for other
 * periods (or with no period) never gate.
 */
export function headlineTrustGate(
  checks: TrustCheck[] | null | undefined,
  cachedPeriod: string | null | undefined,
): TrustGate {
  if (!cachedPeriod) return { gated: false, reason: null };
  const target = norm(cachedPeriod);
  const err = (checks ?? []).find(
    (c) => c.passed !== true && c.severity === "error" && c.period != null && norm(c.period) === target,
  );
  if (!err) return { gated: false, reason: null };
  return { gated: true, reason: err.message };
}

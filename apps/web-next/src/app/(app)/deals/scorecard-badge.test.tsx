import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScorecardBadge } from "./scorecard-badge";
import type { DealScorecard } from "@/types";

function card(verdict: DealScorecard["verdict"], overallScore = 72): DealScorecard {
  return { overallScore, verdict, qualityScore: 70, thesisFitScore: 74, reasons: [], scoredAt: "2026-08-08T00:00:00Z", model: "claude-sonnet-5" };
}

describe("ScorecardBadge", () => {
  it("renders GO with the score", () => {
    render(<ScorecardBadge scorecard={card("GO", 81)} />);
    expect(screen.getByText(/GO 81/)).toBeTruthy();
  });

  it("renders NO-GO", () => {
    render(<ScorecardBadge scorecard={card("NO_GO", 22)} />);
    expect(screen.getByText(/NO-GO 22/)).toBeTruthy();
  });

  it("renders nothing when unscored", () => {
    const { container } = render(<ScorecardBadge scorecard={null} />);
    expect(container.firstChild).toBeNull();
  });
});

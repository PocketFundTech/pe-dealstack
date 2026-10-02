/**
 * Fix plan G7: the Analysis section says why it failed. Before, any failure
 * showed "Something went wrong loading the financial analysis", and a
 * failed AI-insights call left the Insights tab on "AI Insights Loading…"
 * forever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiError } from "@/lib/api";
import { describeLoadError } from "@/lib/errorMessage";
import { AIInsightsPanel } from "./deal-analysis-aiinsights";

describe("describeLoadError", () => {
  it("passes the server's reason through", () => {
    const reason = "AI service (OpenAI) rejected the request: API credits are exhausted.";
    expect(describeLoadError(new ApiError(reason, 503, "AI_PROVIDER_UNAVAILABLE"), "fallback")).toBe(reason);
  });

  it("replaces bare status text with the fallback plus the status", () => {
    expect(describeLoadError(new ApiError("Internal Server Error", 500), "The analysis could not be loaded."))
      .toBe("The analysis could not be loaded. (server error 500). Retry, and contact support if it keeps happening.");
  });

  it("names a network failure and a gateway timeout plainly", () => {
    expect(describeLoadError(new TypeError("Failed to fetch"), "x")).toContain("Couldn't reach the server");
    expect(describeLoadError(new ApiError("Gateway Timeout", 504), "x")).toContain("took too long");
  });
});

describe("AIInsightsPanel", () => {
  const onRetry = vi.fn();
  beforeEach(() => onRetry.mockReset());

  it("shows the failure reason with a Retry, instead of 'Loading…'", () => {
    render(<AIInsightsPanel insights={null} error="API credits are exhausted." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("API credits are exhausted.");
    expect(screen.queryByText(/Loading/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("still shows the pending state when nothing has failed", () => {
    render(<AIInsightsPanel insights={null} />);
    expect(screen.getByText("AI Insights Loading...")).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/render";

const captureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (e: unknown) => captureException(e),
}));

import { ErrorFallback } from "./ErrorFallback";

beforeEach(() => captureException.mockReset());

describe("<ErrorFallback />", () => {
  it("shows the error message and reports it to Sentry", () => {
    const error = Object.assign(new Error("Boom happened"), { digest: "abc123" });
    renderWithProviders(<ErrorFallback error={error} reset={vi.fn()} />);

    expect(screen.getByText(/Boom happened/)).toBeInTheDocument();
    expect(screen.getByText(/ref: abc123/)).toBeInTheDocument();
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("calls reset when 'Try again' is clicked", async () => {
    const reset = vi.fn();
    renderWithProviders(<ErrorFallback error={new Error("x")} reset={reset} />);

    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("falls back to a generic message and omits the button when no reset is given", () => {
    renderWithProviders(<ErrorFallback error={new Error("")} />);

    expect(screen.getByText(/An unexpected error occurred/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

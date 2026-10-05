import { ApiError, NotFoundError } from "@/lib/api";

/** What went wrong with an extraction request, in words the user can act on. */
export function extractionErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") {
    return "Extraction is taking longer than 5 minutes and was stopped on this end. The documents may be too large — try again, or extract one document at a time.";
  }
  if (err instanceof NotFoundError) {
    return "There's no document to extract from yet. Upload a P&L, balance sheet or CIM first.";
  }
  if (err instanceof ApiError && err.message) return err.message;
  if (err instanceof TypeError) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return "Could not extract financial data. Please try again.";
}

/**
 * Every thrown extraction error used to be reported as "document may be
 * encrypted or unsupported" — including "no document to extract from" (404)
 * and "too many extractions running" (429), which have nothing to do with the
 * document.
 */
import { describe, it, expect } from "vitest";
import { ApiError, NotFoundError } from "@/lib/api";
import { extractionErrorMessage } from "./deal-financials-errors";

describe("extractionErrorMessage", () => {
  it("tells the user to upload a document when there is none (404)", () => {
    expect(extractionErrorMessage(new NotFoundError("Not found: /deals/d1/financials/extract")))
      .toMatch(/upload a P&L, balance sheet or CIM/i);
  });

  it("passes through the server's reason (e.g. 429 too many extractions)", () => {
    expect(extractionErrorMessage(new ApiError("Too many concurrent extractions. Please wait.", 429)))
      .toBe("Too many concurrent extractions. Please wait.");
  });

  it("keeps the timeout explanation for an aborted request", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(extractionErrorMessage(abort)).toMatch(/longer than 5 minutes/);
  });

  it("says the server couldn't be reached for a network failure", () => {
    expect(extractionErrorMessage(new TypeError("Failed to fetch"))).toMatch(/couldn't reach the server/i);
  });
});

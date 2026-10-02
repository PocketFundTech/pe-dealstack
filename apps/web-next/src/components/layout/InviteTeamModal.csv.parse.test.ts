import { describe, it, expect } from "vitest";
import { parseCsv, splitCsvLine, validateRows, matchDeal } from "./InviteTeamModal.csv.parse";

const DEALS = [{ id: "d1", name: "Strong Ready Mix" }, { id: "d2", name: "Northwind, Cold Chain" }];

describe("splitCsvLine", () => {
  it("honours quoted commas and escaped quotes", () => {
    expect(splitCsvLine('a@x.com,"Northwind, Cold Chain","say ""hi"""')).toEqual(["a@x.com", "Northwind, Cold Chain", 'say "hi"']);
  });
});

describe("parseCsv (QA #4)", () => {
  it("matches deal names case-insensitively and accepts a 'workspace' column", () => {
    const { rows } = parseCsv('email,role,workspace\na@x.com,associate,strong ready mix\nb@x.com,admin,"Northwind, Cold Chain"', DEALS);
    expect(rows.map((r) => [r.email, r.role, r.dealId, r.checked])).toEqual([
      ["a@x.com", "MEMBER", "d1", true],
      ["b@x.com", "ADMIN", "d2", true],
    ]);
  });
});

describe("validateRows", () => {
  it("flags bad emails, in-file duplicates and unknown deals inline", () => {
    const { rows } = parseCsv("email,deal\nbad-email,\na@x.com,\nA@x.com,\nc@x.com,Nope Inc", DEALS);
    const issues = validateRows(rows);
    expect([...issues.values()]).toEqual([
      "Invalid email",
      "Duplicate email in this file",
      'Deal "Nope Inc" not found — pick one or choose No deal',
    ]);
  });

  it("ignores skipped rows, so unticking a duplicate clears the error", () => {
    const { rows } = parseCsv("email\na@x.com\na@x.com", DEALS);
    rows[1].checked = false;
    expect(validateRows(rows).size).toBe(0);
  });

  it("choosing a deal (or No deal) resolves an unmatched name", () => {
    const { rows } = parseCsv("email,deal\nc@x.com,Nope Inc", DEALS);
    const fixed = rows.map((r) => ({ ...r, dealText: "", dealId: null }));
    expect(validateRows(fixed).size).toBe(0);
    expect(matchDeal(" STRONG READY MIX ", DEALS)).toBe("d1");
  });
});

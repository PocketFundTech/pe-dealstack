/**
 * QA 2026-10-11 (AI Reports deep test, finding A): the sidebar claimed
 * "Using: Standard IC Memo" for every memo, even though no org has ever
 * had a template by that name — it's a hardcoded fallback string, not a
 * real template. Clicking "Change Template" then lands on /templates,
 * which correctly shows "No templates found" in every tab, so the label
 * promised something that isn't there — a dead end.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MemoOutlineSidebar, complianceMessage } from "./outline-sidebar";
import type { MemoSection } from "./components";

const sec = (o: Partial<MemoSection>): MemoSection => ({ id: "s", type: "CUSTOM", title: "T", sortOrder: 1, aiGenerated: false, content: "", ...o });

const baseProps = {
  sections: [],
  activeSection: null,
  setActiveSection: () => {},
  onAddSection: () => {},
};

describe("MemoOutlineSidebar — template label accuracy", () => {
  it("does not claim a specific named template when none is set", () => {
    render(<MemoOutlineSidebar {...baseProps} templateName={undefined} />);
    expect(screen.queryByText("Standard IC Memo")).toBeNull();
  });

  it("shows the real template name when one is actually set", () => {
    render(<MemoOutlineSidebar {...baseProps} templateName="Healthcare Roll-Up Memo" />);
    expect(screen.getByText("Healthcare Roll-Up Memo")).toBeTruthy();
    expect(screen.getByText("Change Template")).toBeTruthy();
  });
});

describe("MemoOutlineSidebar — compliance check honesty", () => {
  it("does not claim verification when no section has generated content", () => {
    render(<MemoOutlineSidebar {...baseProps} sections={[sec({}), sec({ id: "b", aiGenerated: true, content: "" })]} />);
    expect(screen.getByTestId("compliance-status").textContent).not.toMatch(/verified/i);
    expect(screen.getByTestId("compliance-status").textContent).toBe("No generated sections yet — nothing to verify.");
  });

  it("says plainly when generated sections carry no citations", () => {
    expect(complianceMessage([sec({ aiGenerated: true, content: "<p>x</p>" })])).toMatch(/no citations/i);
  });

  it("reports counts only when generated content has citations", () => {
    const msg = complianceMessage([sec({ aiGenerated: true, content: "x", citations: [{}, {}] })]);
    expect(msg).toMatch(/^2 citations across 1 of 1/);
  });
});

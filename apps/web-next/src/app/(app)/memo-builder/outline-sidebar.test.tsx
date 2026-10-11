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
import { MemoOutlineSidebar } from "./outline-sidebar";

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

import { describe, it, expect } from "vitest";
import { shouldStartChatCollapsed } from "./layout-breakpoints";

describe("shouldStartChatCollapsed", () => {
  it("collapses the AI Analyst below 1440px", () => {
    expect(shouldStartChatCollapsed(1280)).toBe(true);
    expect(shouldStartChatCollapsed(1439)).toBe(true);
  });
  it("keeps it open at 1440px and wider", () => {
    expect(shouldStartChatCollapsed(1440)).toBe(false);
    expect(shouldStartChatCollapsed(1920)).toBe(false);
  });
});

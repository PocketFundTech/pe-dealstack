import { describe, it, expect } from "vitest";
import {
  SKILLS,
  findSkillCommand,
  expandChatInput,
  filterSkills,
  unmetRequirements,
  type Deal,
  type Skill,
} from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
//
// `Deal` is `DealDetail` from the deal page. The skill prompt builders only
// read a small surface (`companyName`, `name`, `industry`), so a minimal mock
// that satisfies the required fields is enough. We cast through `unknown`
// instead of using `as any` to keep strict-mode happy without disabling type
// checks.
// ---------------------------------------------------------------------------

const baseDeal: Deal = {
  id: "deal-1",
  name: "Project Alpha",
  companyName: "TestCo",
  stage: "INITIAL_REVIEW",
  industry: "SaaS",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function findSkillByCommand(command: string): Skill {
  const s = SKILLS.find((sk) => sk.command === command);
  if (!s) throw new Error(`Test fixture references missing skill: ${command}`);
  return s;
}

// ---------------------------------------------------------------------------
// findSkillCommand
// ---------------------------------------------------------------------------

describe("findSkillCommand — happy path", () => {
  it("returns the matched skill with empty extra on exact command match (/ic-memo)", () => {
    const result = findSkillCommand("/ic-memo");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/ic-memo");
    expect(result?.extra).toBe("");
  });

  it("returns matched skill + trailing text when separated by a single space", () => {
    const result = findSkillCommand("/ic-memo focus on retention risk");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/ic-memo");
    expect(result?.extra).toBe("focus on retention risk");
  });

  it("returns matched skill + trailing text when separated by a newline", () => {
    const result = findSkillCommand("/ic-memo\nfocus on retention risk");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/ic-memo");
    expect(result?.extra).toBe("focus on retention risk");
  });

  it("returns matched skill + trailing text when separated by a tab", () => {
    const result = findSkillCommand("/ic-memo\tfocus on retention risk");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/ic-memo");
    expect(result?.extra).toBe("focus on retention risk");
  });

  it("trims whitespace around the extra context", () => {
    const result = findSkillCommand("/ic-memo    focus on retention risk   ");
    expect(result?.extra).toBe("focus on retention risk");
  });

  it("matches /chart-revenue and does NOT collide with /chart-margin", () => {
    const result = findSkillCommand("/chart-revenue please");
    expect(result?.skill.command).toBe("/chart-revenue");
  });

  it("matches /chart-margin and does NOT collide with /chart-revenue", () => {
    const result = findSkillCommand("/chart-margin please");
    expect(result?.skill.command).toBe("/chart-margin");
  });

  it("matches /chart-comp-mults distinctly from the other chart commands", () => {
    const result = findSkillCommand("/chart-comp-mults");
    expect(result?.skill.command).toBe("/chart-comp-mults");
  });

  it("matches every registered command with empty extra on bare invocation", () => {
    for (const skill of SKILLS) {
      const result = findSkillCommand(skill.command);
      expect(result).not.toBeNull();
      expect(result?.skill.command).toBe(skill.command);
      expect(result?.extra).toBe("");
    }
  });

  it("matches with leading whitespace (function uses trimStart)", () => {
    const result = findSkillCommand("  /ic-memo");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/ic-memo");
    expect(result?.extra).toBe("");
  });

  it("matches with leading whitespace + extra text", () => {
    const result = findSkillCommand("   /qoe-flags watch AR trends");
    expect(result?.skill.command).toBe("/qoe-flags");
    expect(result?.extra).toBe("watch AR trends");
  });

  it("preserves internal whitespace inside extra context", () => {
    const result = findSkillCommand("/ic-memo line one\nline two");
    expect(result?.extra).toBe("line one\nline two");
  });
});

describe("findSkillCommand — negative cases", () => {
  it("returns null for input without a leading slash", () => {
    expect(findSkillCommand("ic-memo")).toBeNull();
  });

  it("returns null for an unknown command", () => {
    expect(findSkillCommand("/totally-made-up")).toBeNull();
  });

  it("returns null for /ic-memo-v2 (prefix-overlap of /ic-memo — anchored match must reject)", () => {
    // CRITICAL: anchored-match logic exists specifically to prevent this
    // kind of collision. If a future /ic-memo-v2 is added, the parser must
    // not mis-route it to /ic-memo.
    const result = findSkillCommand("/ic-memo-v2");
    expect(result).toBeNull();
  });

  it("returns null for /ic-memo-v2 with trailing text (still a prefix collision)", () => {
    expect(findSkillCommand("/ic-memo-v2 some extra")).toBeNull();
  });

  it("returns null for /chart-revenue-extra (prefix overlap of /chart-revenue)", () => {
    expect(findSkillCommand("/chart-revenue-extra")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(findSkillCommand("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(findSkillCommand("   ")).toBeNull();
  });

  it("returns null when a command appears mid-string rather than at the start", () => {
    expect(findSkillCommand("hello /ic-memo world")).toBeNull();
  });

  it("returns null for a bare slash", () => {
    expect(findSkillCommand("/")).toBeNull();
  });

  it("returns null when the command is followed immediately by a non-whitespace character", () => {
    // /ic-memo: would prefix-match /ic-memo with separator ':', which the
    // parser rejects (only space / tab / newline allowed).
    expect(findSkillCommand("/ic-memo:foo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// expandChatInput
// ---------------------------------------------------------------------------

describe("expandChatInput", () => {
  it("returns input unchanged when there is no matching command", () => {
    const input = "just a regular chat message";
    expect(expandChatInput(input, baseDeal)).toBe(input);
  });

  it("returns input unchanged when deal is null (early-return guard) even if command matches", () => {
    // Documented guard: null deal short-circuits before parsing. The raw
    // text reaches the agent verbatim — including any leading slash.
    expect(expandChatInput("/ic-memo", null)).toBe("/ic-memo");
  });

  it("returns input unchanged when deal is null and input is plain text", () => {
    expect(expandChatInput("hello world", null)).toBe("hello world");
  });

  it("returns the skill's full prompt when command matches with no extra context", () => {
    const skill = findSkillByCommand("/ic-memo");
    const expected = skill.buildPrompt(baseDeal);
    const result = expandChatInput("/ic-memo", baseDeal);
    expect(result).toBe(expected);
  });

  it("appends an 'Additional context from the analyst' block when extra is present", () => {
    const skill = findSkillByCommand("/ic-memo");
    const base = skill.buildPrompt(baseDeal);
    const result = expandChatInput(
      "/ic-memo focus on FY25 churn forecast",
      baseDeal,
    );
    expect(result).toBe(
      `${base}\n\n---\n**Additional context from the analyst:**\nfocus on FY25 churn forecast`,
    );
  });

  it("uses the analyst-context separator exactly once even with newlines in extra", () => {
    const result = expandChatInput("/qoe-flags\nline one\nline two", baseDeal);
    expect(result).toContain(
      "---\n**Additional context from the analyst:**\nline one\nline two",
    );
    expect(result.match(/---\n\*\*Additional context from the analyst:\*\*/g))
      .toHaveLength(1);
  });

  it("substitutes the deal company name into prompts that reference nameOf(deal)", () => {
    const result = expandChatInput("/ic-memo", baseDeal);
    expect(result).toContain("TestCo");
  });

  it("falls back to deal.name when companyName is absent", () => {
    const noCompany: Deal = { ...baseDeal, companyName: undefined };
    const result = expandChatInput("/ic-memo", noCompany);
    expect(result).toContain("Project Alpha");
  });

  it("falls back to 'this company' when both companyName and name are absent", () => {
    const anonymous: Deal = {
      ...baseDeal,
      companyName: undefined,
      // name is required on Deal, but the helper guards against empty too.
      name: "",
    };
    const result = expandChatInput("/ic-memo", anonymous);
    expect(result).toContain("this company");
  });

  it("includes the industry clause for prompts that reference industryOf(deal)", () => {
    const result = expandChatInput("/ic-memo", baseDeal);
    expect(result).toContain("SaaS");
  });

  it("returns input verbatim for an unknown command (no expansion attempted)", () => {
    const input = "/totally-made-up extra stuff";
    expect(expandChatInput(input, baseDeal)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// /follow-ups — registered and wired to live integrations
//
// `/follow-ups` was previously gated off; it is now registered and calls
// THREE tools: `get_deal_activity` (in-app), `get_recent_emails_for_deal`
// (live Gmail), and `get_upcoming_meetings_for_deal` (live Google Calendar).
// These tests lock in the registration AND verify the prompt names all
// three tools + handles their failure modes (so the agent knows what to do
// when Gmail/Calendar isn't connected).
// ---------------------------------------------------------------------------

describe("/follow-ups — registered and wired to live integrations", () => {
  it("is present in the SKILLS registry", () => {
    expect(SKILLS.some((s) => s.command === "/follow-ups")).toBe(true);
    expect(SKILLS.some((s) => s.id === "follow-ups")).toBe(true);
  });

  it("is findable via findSkillCommand", () => {
    const result = findSkillCommand("/follow-ups");
    expect(result).not.toBeNull();
    expect(result?.skill.command).toBe("/follow-ups");
  });

  it("is surfaced by filterSkills", () => {
    expect(filterSkills("follow").some((s) => s.id === "follow-ups")).toBe(true);
  });

  it("expands /follow-ups to a prompt that calls all three required tools", () => {
    const result = expandChatInput("/follow-ups", baseDeal);
    expect(result).toContain("get_deal_activity");
    expect(result).toContain("get_recent_emails_for_deal");
    expect(result).toContain("get_upcoming_meetings_for_deal");
  });

  it("handles the 'Gmail not connected' tool response in its prompt", () => {
    // The prompt must explicitly reference the not-connected fallback string
    // (or a verbatim instruction to surface it) so the agent knows what to do
    // when the integration is unconfigured.
    const result = expandChatInput("/follow-ups", baseDeal);
    expect(result).toContain("Gmail not connected");
  });

  it("declares the mailIntegration requirement so the menu can badge it", () => {
    const followUps = SKILLS.find((s) => s.command === "/follow-ups");
    expect(followUps?.requires?.mailIntegration).toBe(true);
  });

  it("mandates a data-source provenance header so the analyst can verify Gmail/Calendar were queried", () => {
    // Without this header, the agent's reply hides whether the integration
    // tools were called, returned empty, or were skipped. The whole point of
    // this skill is trust-but-verify — provenance is non-negotiable.
    const result = expandChatInput("/follow-ups", baseDeal);
    expect(result).toContain("Pulled from: in-app activity");
    expect(result).toContain("Gmail (M emails)");
    expect(result).toContain("Calendar (K events)");
    expect(result).toContain("MANDATORY"); // hammered both at output spec + final reminder
  });
});

// ---------------------------------------------------------------------------
// unmetRequirements — mail integration gate
//
// `/follow-ups` (and any future skill that reads the user's mailbox) needs
// a connected Gmail/Calendar/Outlook integration to be useful. The menu UI
// calls `unmetRequirements(skill, deal, { hasMailIntegration })` so the row
// shows a "needs Gmail or Outlook" badge when the current user hasn't
// connected anything. The check is BADGE-ONLY — invocation isn't blocked,
// matching how `requires: { sector: true }` works for /dd-checklist.
// ---------------------------------------------------------------------------

describe("unmetRequirements — mailIntegration", () => {
  const followUps = SKILLS.find((s) => s.command === "/follow-ups")!;

  it("returns the 'needs Gmail or Outlook' badge when ctx says false", () => {
    expect(unmetRequirements(followUps, baseDeal, { hasMailIntegration: false }))
      .toContain("needs Gmail or Outlook");
  });

  it("returns the same badge when ctx is omitted entirely (conservative default)", () => {
    // Documented behavior — if a caller forgets to pass ctx, we treat the
    // requirement as unmet so the badge still shows. Better than silently
    // hiding the connect-to-enable hint.
    expect(unmetRequirements(followUps, baseDeal))
      .toContain("needs Gmail or Outlook");
  });

  it("omits the badge when ctx confirms a connected mail integration", () => {
    expect(unmetRequirements(followUps, baseDeal, { hasMailIntegration: true }))
      .not.toContain("needs Gmail or Outlook");
  });

  it("does NOT badge skills that don't declare the mailIntegration requirement", () => {
    const icMemo = SKILLS.find((s) => s.command === "/ic-memo")!;
    expect(unmetRequirements(icMemo, baseDeal, { hasMailIntegration: false }))
      .not.toContain("needs Gmail or Outlook");
  });
});

describe("filterSkills", () => {
  it("returns all skills for an empty query", () => {
    expect(filterSkills("").length).toBe(SKILLS.length);
    expect(filterSkills("   ").length).toBe(SKILLS.length);
  });

  it("matches against command (with leading slash)", () => {
    const hits = filterSkills("/ic-memo");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((s) => s.id === "ic-memo")).toBe(true);
  });

  it("matches against command (without leading slash) — the menu-input convention", () => {
    const hits = filterSkills("qoe");
    expect(hits.some((s) => s.id === "qoe-flags")).toBe(true);
  });

  it("matches against the label so analysts searching by name find it", () => {
    const hits = filterSkills("Investment Committee");
    expect(hits.some((s) => s.id === "ic-memo")).toBe(true);
  });

  it("matches against the description so intent-based searches work — 'red flags' finds qoeFlags", () => {
    // qoeFlags description: "Quality of Earnings red flags grouped by category with severity."
    // The phrase "red flags" appears in NO command or label, only the description.
    const hits = filterSkills("red flags");
    expect(hits.some((s) => s.id === "qoe-flags")).toBe(true);
  });

  it("matches against the description for other intent phrases ('memo', 'chart', 'comp')", () => {
    expect(filterSkills("memo").some((s) => s.category === "memo")).toBe(true);
    expect(filterSkills("chart").some((s) => s.category === "visual")).toBe(true);
    expect(filterSkills("comparable").some((s) => s.id === "comp-bench")).toBe(true);
  });

  it("returns empty array for a query that matches nothing", () => {
    expect(filterSkills("xyznosuchthing").length).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(filterSkills("IC-MEMO").some((s) => s.id === "ic-memo")).toBe(true);
    expect(filterSkills("RED FLAGS").some((s) => s.id === "qoe-flags")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 skills — /regulatory-scan, /ma-precedents, /customer-concentration
//
// These ship alongside (not replacing) /regulatory-risk and
// /precedent-transactions. The tests below assert both the new skills exist
// AND the old ones still resolve, so an accidental rename in either skill
// breaks the suite immediately.
// ---------------------------------------------------------------------------

describe("/regulatory-scan — registered alongside /regulatory-risk", () => {
  it("is present in the SKILLS registry", () => {
    expect(SKILLS.some((s) => s.command === "/regulatory-scan")).toBe(true);
    expect(SKILLS.some((s) => s.id === "regulatory-scan")).toBe(true);
  });

  it("coexists with the original /regulatory-risk", () => {
    expect(SKILLS.some((s) => s.command === "/regulatory-risk")).toBe(true);
    expect(SKILLS.some((s) => s.command === "/regulatory-scan")).toBe(true);
  });

  it("is findable via findSkillCommand without colliding with /regulatory-risk", () => {
    expect(findSkillCommand("/regulatory-scan")?.skill.command).toBe("/regulatory-scan");
    expect(findSkillCommand("/regulatory-risk")?.skill.command).toBe("/regulatory-risk");
  });

  it("filterSkills('regulatory') surfaces BOTH the scan and the risk skill", () => {
    const hits = filterSkills("regulatory");
    expect(hits.some((s) => s.id === "regulatory-scan")).toBe(true);
    expect(hits.some((s) => s.id === "regulatory-risk")).toBe(true);
  });

  it("expands to a prompt that calls the documented tool combo", () => {
    const result = expandChatInput("/regulatory-scan", baseDeal);
    expect(result).toContain("search_documents");
    expect(result).toContain("get_deal_documents");
    expect(result).toContain("web_search");
  });

  it("declares the sector requirement so the menu can badge it", () => {
    const skill = findSkillByCommand("/regulatory-scan");
    expect(skill.requires?.sector).toBe(true);
  });

  it("hard-stops with a single question when the deal has no industry", () => {
    const noIndustry: Deal = { ...baseDeal, industry: undefined };
    const result = expandChatInput("/regulatory-scan", noIndustry);
    expect(result).toContain("no industry on file");
    expect(result).toContain("STOP");
    // Sanity: the full output spec MUST NOT appear in the hard-stop branch —
    // a leaked section header here means the guard regressed.
    expect(result).not.toContain("### Current Regulatory Framework");
  });
});

describe("/ma-precedents — registered alongside /precedent-transactions", () => {
  it("is present in the SKILLS registry", () => {
    expect(SKILLS.some((s) => s.command === "/ma-precedents")).toBe(true);
    expect(SKILLS.some((s) => s.id === "ma-precedents")).toBe(true);
  });

  it("coexists with the original /precedent-transactions", () => {
    expect(SKILLS.some((s) => s.command === "/precedent-transactions")).toBe(true);
    expect(SKILLS.some((s) => s.command === "/ma-precedents")).toBe(true);
  });

  it("is findable via findSkillCommand", () => {
    expect(findSkillCommand("/ma-precedents")?.skill.command).toBe("/ma-precedents");
  });

  it("filterSkills('precedent') surfaces BOTH skills", () => {
    const hits = filterSkills("precedent");
    expect(hits.some((s) => s.id === "ma-precedents")).toBe(true);
    expect(hits.some((s) => s.id === "precedent-transactions")).toBe(true);
  });

  it("expands to a prompt that pulls internal + external comps and target financials", () => {
    const result = expandChatInput("/ma-precedents", baseDeal);
    expect(result).toContain("compare_deals");
    expect(result).toContain("web_search");
    expect(result).toContain("get_deal_financials");
  });

  it("declares the sector requirement", () => {
    const skill = findSkillByCommand("/ma-precedents");
    expect(skill.requires?.sector).toBe(true);
  });

  it("hard-stops when the deal has no industry", () => {
    const noIndustry: Deal = { ...baseDeal, industry: undefined };
    const result = expandChatInput("/ma-precedents", noIndustry);
    expect(result).toContain("no industry on file");
    expect(result).toContain("STOP");
    expect(result).not.toContain("### Precedent Transactions Table");
  });
});

describe("/customer-concentration — documents-driven analysis skill", () => {
  it("is present in the SKILLS registry", () => {
    expect(SKILLS.some((s) => s.command === "/customer-concentration")).toBe(true);
    expect(SKILLS.some((s) => s.id === "customer-concentration")).toBe(true);
  });

  it("is findable via findSkillCommand", () => {
    expect(findSkillCommand("/customer-concentration")?.skill.command).toBe(
      "/customer-concentration",
    );
  });

  it("is surfaced by filterSkills('customer') and 'concentration'", () => {
    expect(filterSkills("customer").some((s) => s.id === "customer-concentration")).toBe(true);
    expect(
      filterSkills("concentration").some((s) => s.id === "customer-concentration"),
    ).toBe(true);
  });

  it("expands to a prompt that hits every internal data source", () => {
    const result = expandChatInput("/customer-concentration", baseDeal);
    expect(result).toContain("get_deal_financials");
    expect(result).toContain("search_documents");
    expect(result).toContain("get_deal_documents");
    expect(result).toContain("get_analysis_summary");
  });

  it("declares the documents requirement so the menu can badge it", () => {
    const skill = findSkillByCommand("/customer-concentration");
    expect(skill.requires?.documents).toBe(true);
  });

  it("badges 'needs documents' when the deal has no uploaded docs", () => {
    const skill = findSkillByCommand("/customer-concentration");
    expect(unmetRequirements(skill, baseDeal)).toContain("needs documents");
    const withDocs: Deal = {
      ...baseDeal,
      documents: [
        {
          id: "doc-1",
          fileName: "CIM.pdf",
          documentType: "cim",
          dealId: baseDeal.id,
          uploadedById: "user-1",
          aiSummary: null,
          tags: [],
          isProcessed: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } as unknown as Deal["documents"] extends (infer T)[] | undefined ? T : never,
      ],
    };
    expect(unmetRequirements(skill, withDocs)).not.toContain("needs documents");
  });

  it("does NOT require a sector (analysis works on any deal with docs)", () => {
    const skill = findSkillByCommand("/customer-concentration");
    expect(skill.requires?.sector).toBeUndefined();
  });
});

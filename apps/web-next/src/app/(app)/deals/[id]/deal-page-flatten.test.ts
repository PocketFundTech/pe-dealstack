/**
 * page.tsx moved the GET /deals/:id fetch onto useApiQuery so revisiting a
 * deal renders instantly from cache. The raw API response is flattened
 * (teamMembers -> team) at render time via flattenDeal, and every existing
 * setDeal(...) call site now round-trips through flattenDeal via the
 * mutateApiCache-backed adapter in the page. flattenDeal must therefore be
 * idempotent -- safe to apply to data that's already been flattened once --
 * or a second setDeal() call (e.g. confirmStageChange's setDeal(updated))
 * would silently wipe the team list.
 */
import { describe, it, expect } from "vitest";
import { flattenDeal, type RawDeal } from "./deal-page-flatten";

const base = {
  id: "d1",
  name: "Meridian Coatings",
  stage: "DUE_DILIGENCE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("flattenDeal", () => {
  it("derives team from the raw teamMembers join", () => {
    const raw: RawDeal = {
      ...base,
      teamMembers: [
        { role: "LEAD", user: { id: "u1", name: "Alex Partner", email: "alex@firm.com" } },
        { role: "MEMBER", user: { id: "u2", name: "Sam Analyst" } },
      ],
    };
    const flat = flattenDeal(raw);
    expect(flat.team).toEqual([
      { id: "u1", name: "Alex Partner", avatar: undefined, email: "alex@firm.com", role: "LEAD" },
      { id: "u2", name: "Sam Analyst", avatar: undefined, email: undefined, role: "MEMBER" },
    ]);
  });

  it("prefers an already-flat team over teamMembers when both are present", () => {
    const raw: RawDeal = {
      ...base,
      team: [{ id: "u9", name: "Existing", role: "LEAD" }],
      teamMembers: [{ role: "MEMBER", user: { id: "u2", name: "Sam Analyst" } }],
    };
    expect(flattenDeal(raw).team).toEqual([{ id: "u9", name: "Existing", role: "LEAD" }]);
  });

  it("is idempotent -- flattening an already-flat deal returns the same team", () => {
    const raw: RawDeal = { ...base, teamMembers: [{ role: "LEAD", user: { id: "u1", name: "Alex" } }] };
    const once = flattenDeal(raw);
    const twice = flattenDeal(once);
    expect(twice.team).toEqual(once.team);
  });

  it("defaults team to [] when there is no team data at all", () => {
    expect(flattenDeal({ ...base })).toMatchObject({ team: [] });
  });
});

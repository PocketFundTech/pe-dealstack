/**
 * The stage-change modal collects "Reason for stage change…", but the PATCH
 * sent only { stage }, so the note the user typed silently disappeared.
 */
import { describe, it, expect, vi } from "vitest";

const patch = vi.fn(async (_path: string, body: Record<string, unknown>) => ({ id: "d1", stage: body.stage }));
vi.mock("@/lib/api", () => ({ api: { patch: (path: string, body: Record<string, unknown>) => patch(path, body) } }));

import { confirmStageChange } from "./deal-page-handlers";

function deps(stageNote: string) {
  return {
    dealId: "d1",
    stageModal: { from: "DUE_DILIGENCE", to: "LOI_SUBMITTED" },
    stageNote,
    deal: { id: "d1", stage: "DUE_DILIGENCE" } as never,
    setStageChanging: vi.fn(),
    setStageError: vi.fn(),
    setDeal: vi.fn(),
    setStageModal: vi.fn(),
    loadActivities: vi.fn(async () => {}),
  };
}

describe("confirmStageChange", () => {
  it("sends the stage-change note with the new stage", async () => {
    await confirmStageChange(deps("Mgmt call went well"));
    expect(patch).toHaveBeenCalledWith("/deals/d1", { stage: "LOI_SUBMITTED", stageNote: "Mgmt call went well" });
  });

  it("omits the note when the user left it blank", async () => {
    patch.mockClear();
    await confirmStageChange(deps("   "));
    expect(patch).toHaveBeenCalledWith("/deals/d1", { stage: "LOI_SUBMITTED" });
  });
});

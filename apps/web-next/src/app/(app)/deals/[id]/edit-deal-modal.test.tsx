/**
 * Batch 3: EditDealModal's backdrop click and Cancel button used to call
 * onClose() directly, silently discarding whatever the user had typed. They
 * now route through a confirm dialog when the form is dirty, and still close
 * immediately when nothing changed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditDealModal } from "./edit-deal-modal";
import type { DealDetail } from "./deal-detail-shared";

vi.mock("@/lib/api", () => ({ api: { patch: vi.fn() } }));

const deal: DealDetail = {
  id: "deal-1",
  name: "Meridian Coatings",
  stage: "DUE_DILIGENCE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("EditDealModal — discard confirmation", () => {
  it("closes immediately on Cancel when nothing changed", () => {
    const onClose = vi.fn();
    render(<EditDealModal deal={deal} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
  });

  it("shows a confirm dialog instead of closing when the form is dirty", () => {
    const onClose = vi.fn();
    render(<EditDealModal deal={deal} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("Meridian Coatings"), { target: { value: "Meridian Coatings II" } });
    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Discard"));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the modal open and the edit intact when the user cancels the discard prompt", () => {
    const onClose = vi.fn();
    render(<EditDealModal deal={deal} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue("Meridian Coatings"), { target: { value: "Meridian Coatings II" } });
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Keep editing"));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Meridian Coatings II")).toBeInTheDocument();
  });
});

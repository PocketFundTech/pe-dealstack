import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UploadConfirmModal } from "./components";

describe("UploadConfirmModal", () => {
  it("lists the files that won't be uploaded and why", () => {
    render(
      <UploadConfirmModal
        files={[new File(["x"], "cim.pdf", { type: "application/pdf" })]}
        skipped={[{ name: "notes.txt", reason: "unsupported file type" }]}
        autoUpdateDeal={false}
        uploading={false}
        onAutoUpdateChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 file won.t be uploaded/)).toBeTruthy();
    expect(screen.getByText("notes.txt: unsupported file type")).toBeTruthy();
  });
});

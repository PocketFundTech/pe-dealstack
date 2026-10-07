import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { DuplicateDealModal, useDuplicatePrompt } from "./DuplicateDealModal";
import type { DuplicateCheck } from "./duplicateCheck";

const CHECK: DuplicateCheck = {
  extractedCompanyName: "CSP",
  candidates: [
    { id: "d1", name: "CSP", companyName: "CSP", reason: "exact" },
    { id: "d2", name: "Community Solar Platform", companyName: "Community Solar Platform Holdings", reason: "similar" },
  ],
};

describe("DuplicateDealModal", () => {
  it("lists every candidate with same / similar name and a link to open it", () => {
    render(<DuplicateDealModal check={CHECK} onDecide={() => {}} />);
    expect(screen.getByText("This looks like a deal you already have")).toBeInTheDocument();
    expect(screen.getByText("Same name")).toBeInTheDocument();
    expect(screen.getByText("Similar name")).toBeInTheDocument();
    expect(screen.getByText("Community Solar Platform Holdings")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /open deal/i });
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/deals/d1", "/deals/d2"]);
    expect(links[0]).toHaveAttribute("target", "_blank");
  });

  it("reports each choice", () => {
    const onDecide = vi.fn();
    render(<DuplicateDealModal check={CHECK} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: /add to community solar platform/i }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "add", dealId: "d2", dealName: "Community Solar Platform" });
    fireEvent.click(screen.getByRole("button", { name: "Create a new deal anyway" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "create" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDecide).toHaveBeenLastCalledWith({ action: "cancel" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDecide).toHaveBeenCalledTimes(4);
    expect(onDecide).toHaveBeenLastCalledWith({ action: "cancel" });
  });
});

describe("useDuplicatePrompt", () => {
  it("opens the modal and resolves with the user's choice, then closes", async () => {
    const { result } = renderHook(() => useDuplicatePrompt());
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.askDuplicate(CHECK); });
    const { unmount } = render(<>{result.current.modal}</>);
    fireEvent.click(screen.getByRole("button", { name: "Create a new deal anyway" }));
    await expect(pending).resolves.toEqual({ action: "create" });
    expect(result.current.modal).toBeNull();
    unmount();
  });

  it("resolves as cancel if the form unmounts mid-question", async () => {
    const { result, unmount } = renderHook(() => useDuplicatePrompt());
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.askDuplicate(CHECK); });
    unmount();
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });
});

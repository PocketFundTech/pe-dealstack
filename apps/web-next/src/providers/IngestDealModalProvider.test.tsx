/**
 * Most "New Deal" buttons pass openDealIntake straight to onClick, so it was
 * called with the click event. The provider treated the event as a deal and
 * opened the modal in "Update Existing Deal" mode with a blank deal selected.
 */
import { render, fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const modalProps = vi.fn();
vi.mock("@/components/deal-intake/IngestDealModal", () => ({
  IngestDealModal: (props: unknown) => {
    modalProps(props);
    return null;
  },
}));

import { IngestDealModalProvider, useIngestDealModal } from "./IngestDealModalProvider";

function Buttons() {
  const { openDealIntake } = useIngestDealModal();
  return (
    <>
      {/* The buggy caller pattern: the click event becomes the argument. */}
      <button onClick={openDealIntake as never}>New Deal</button>
      <button onClick={() => openDealIntake({ id: "deal-1", name: "Acme" })}>Add document</button>
    </>
  );
}

function lastProps() {
  return modalProps.mock.calls.at(-1)![0] as { open: boolean; preselectedDeal: unknown };
}

describe("openDealIntake", () => {
  beforeEach(() => modalProps.mockClear());

  it("opens in create-new mode when wired as onClick={openDealIntake}", () => {
    render(<IngestDealModalProvider><Buttons /></IngestDealModalProvider>);
    fireEvent.click(screen.getByText("New Deal"));
    expect(lastProps()).toMatchObject({ open: true, preselectedDeal: null });
  });

  it("still pre-selects a real deal", () => {
    render(<IngestDealModalProvider><Buttons /></IngestDealModalProvider>);
    fireEvent.click(screen.getByText("Add document"));
    expect(lastProps()).toMatchObject({ open: true, preselectedDeal: { id: "deal-1", name: "Acme" } });
  });
});

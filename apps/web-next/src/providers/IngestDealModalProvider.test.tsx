/**
 * Most "New Deal" buttons pass openDealIntake straight to onClick, so it was
 * called with the click event. The provider treated the event as a deal and
 * opened the modal in "Update Existing Deal" mode with a blank deal selected.
 */
import { render, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const modalProps = vi.fn();
vi.mock("@/components/deal-intake/IngestDealModal", () => ({
  IngestDealModal: (props: unknown) => {
    modalProps(props);
    return null;
  },
}));

import { IngestDealModalProvider, useIngestDealModal } from "./IngestDealModalProvider";

let open: ReturnType<typeof useIngestDealModal>["openDealIntake"];
function Grab() {
  open = useIngestDealModal().openDealIntake;
  return null;
}

function lastProps() {
  return modalProps.mock.calls.at(-1)![0] as { open: boolean; preselectedDeal: unknown };
}

describe("openDealIntake", () => {
  beforeEach(() => modalProps.mockClear());

  it("opens in create-new mode when called with a click event (onClick={openDealIntake})", () => {
    render(<IngestDealModalProvider><Grab /></IngestDealModalProvider>);
    const clickEvent = { type: "click", target: {}, preventDefault() {} };
    act(() => open(clickEvent as never));
    expect(lastProps()).toMatchObject({ open: true, preselectedDeal: null });
  });

  it("still pre-selects a real deal", () => {
    render(<IngestDealModalProvider><Grab /></IngestDealModalProvider>);
    act(() => open({ id: "deal-1", name: "Acme" }));
    expect(lastProps()).toMatchObject({ open: true, preselectedDeal: { id: "deal-1", name: "Acme" } });
  });
});

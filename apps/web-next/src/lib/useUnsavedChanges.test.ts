import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useUnsavedChanges } from "./useUnsavedChanges";

function fireBeforeUnload(): BeforeUnloadEvent {
  const event = new Event("beforeunload") as BeforeUnloadEvent;
  Object.defineProperty(event, "preventDefault", { value: vi.fn() });
  window.dispatchEvent(event);
  return event;
}

describe("useUnsavedChanges", () => {
  it("does not intercept beforeunload when not dirty", () => {
    renderHook(() => useUnsavedChanges(false));
    const event = fireBeforeUnload();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("intercepts beforeunload when dirty", () => {
    renderHook(() => useUnsavedChanges(true));
    const event = fireBeforeUnload();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("stops intercepting once isDirty flips back to false", () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedChanges(dirty), {
      initialProps: { dirty: true },
    });
    rerender({ dirty: false });
    const event = fireBeforeUnload();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

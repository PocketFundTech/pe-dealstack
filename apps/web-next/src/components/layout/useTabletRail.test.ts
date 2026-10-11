import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTabletRail, TABLET_QUERY } from "./useTabletRail";

function mockMatchMedia(matches: boolean) {
  let listener: ((e: MediaQueryListEvent) => void) | null = null;
  const mq = {
    matches,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => { listener = l; },
    removeEventListener: vi.fn(),
  };
  const spy = vi.fn(() => mq);
  vi.stubGlobal("matchMedia", spy);
  window.matchMedia = spy as unknown as typeof window.matchMedia;
  return { spy, fire: (m: boolean) => listener?.({ matches: m } as MediaQueryListEvent) };
}

afterEach(() => vi.unstubAllGlobals());

describe("useTabletRail", () => {
  it("fires immediately when already at tablet width", () => {
    const { spy } = mockMatchMedia(true);
    const cb = vi.fn();
    renderHook(() => useTabletRail(cb));
    expect(spy).toHaveBeenCalledWith(TABLET_QUERY);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it("does not fire at desktop width", () => {
    mockMatchMedia(false);
    const cb = vi.fn();
    renderHook(() => useTabletRail(cb));
    expect(cb).not.toHaveBeenCalled();
  });
  it("fires when the viewport crosses into the tablet range", () => {
    const { fire } = mockMatchMedia(false);
    const cb = vi.fn();
    renderHook(() => useTabletRail(cb));
    fire(true);
    expect(cb).toHaveBeenCalledTimes(1);
    fire(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

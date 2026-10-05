import { describe, it, expect, vi } from "vitest";
import { pollTeasers } from "./teaserPoll";

const noopSleep = () => Promise.resolve();

describe("pollTeasers", () => {
  it("returns teasers as soon as a poll returns a non-empty array", async () => {
    const fetchTeasers = vi
      .fn()
      .mockResolvedValueOnce({ teasers: [] })
      .mockResolvedValueOnce({ teasers: [{ id: "t1" }] });

    const result = await pollTeasers("deal-1", {
      isCancelled: () => false,
      fetchTeasers,
      sleep: noopSleep,
    });

    expect(result).toEqual([{ id: "t1" }]);
    expect(fetchTeasers).toHaveBeenCalledTimes(2);
    expect(fetchTeasers).toHaveBeenCalledWith("deal-1");
  });

  it("stops polling and returns null once isCancelled() reports true", async () => {
    let cancelled = false;
    const fetchTeasers = vi.fn().mockImplementation(async () => {
      cancelled = true; // cancel after the first poll
      return { teasers: [] };
    });

    const result = await pollTeasers("deal-1", {
      isCancelled: () => cancelled,
      fetchTeasers,
      sleep: noopSleep,
    });

    expect(result).toBeNull();
    expect(fetchTeasers).toHaveBeenCalledTimes(1);
  });

  it("gives up and returns null once the timeout elapses", async () => {
    const fetchTeasers = vi.fn().mockResolvedValue({ teasers: [] });
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      now += ms;
    });

    const result = await pollTeasers("deal-1", {
      isCancelled: () => false,
      fetchTeasers,
      sleep,
      intervalMs: 2000,
      timeoutMs: 5000,
    });

    expect(result).toBeNull();
    // start=0: poll(0) -> sleep(2000) -> now=2000: poll -> sleep(2000) ->
    // now=4000: poll -> loop condition now-start(4000) < 5000 true -> sleep
    // -> now=6000, loop exits. Exact call count isn't the contract — just
    // that it stops instead of polling forever.
    expect(fetchTeasers.mock.calls.length).toBeGreaterThan(0);
    expect(fetchTeasers.mock.calls.length).toBeLessThan(10);
    dateSpy.mockRestore();
  });

  it("does not fetch at all if already cancelled before the first poll", async () => {
    const fetchTeasers = vi.fn().mockResolvedValue({ teasers: [] });
    const result = await pollTeasers("deal-1", {
      isCancelled: () => true,
      fetchTeasers,
      sleep: noopSleep,
    });
    expect(result).toBeNull();
    expect(fetchTeasers).not.toHaveBeenCalled();
  });

  it("stops polling (returns null) when a fetch throws, instead of retrying forever", async () => {
    const fetchTeasers = vi.fn().mockRejectedValue(new Error("network down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await pollTeasers("deal-1", {
      isCancelled: () => false,
      fetchTeasers,
      sleep: noopSleep,
    });

    expect(result).toBeNull();
    expect(fetchTeasers).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGenerateAll } from "./section-handlers";
import type { MemoSection } from "./components";

const streamMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: { stream: (...args: unknown[]) => streamMock(...args) } }));

type OnEvent = (event: Record<string, unknown>) => void;
type GenerateAllDeps = Parameters<typeof createGenerateAll>[0];

function makeDeps() {
  let sections: MemoSection[] = [];
  const setSections = vi.fn((updater: unknown) => {
    sections = typeof updater === "function"
      ? (updater as (prev: MemoSection[]) => MemoSection[])(sections)
      : (updater as MemoSection[]);
  });
  const setEditingContent = vi.fn();
  const setActiveSection = vi.fn();
  const setGeneratingAll = vi.fn();
  const setGenerationStatus = vi.fn();
  const setError = vi.fn();

  const deps = {
    selectedMemo: { id: "memo-1" },
    setSections,
    setEditingContent,
    setActiveSection,
    setGeneratingAll,
    setGenerationStatus,
    setError,
  } as unknown as GenerateAllDeps;
  return { deps, getSections: () => sections, setGeneratingAll, setGenerationStatus, setError };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("createGenerateAll (streaming)", () => {
  it("upserts a section into state as soon as its section_complete event arrives", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: OnEvent) => {
      onEvent({ type: "section_start", sectionType: "EXECUTIVE_SUMMARY", index: 1, total: 2 });
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 2,
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ type: "EXECUTIVE_SUMMARY", content: "<p>draft</p>" });
  });

  it("updates the same section in place (not duplicated) on a later section_revised event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: OnEvent) => {
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 1,
      });
      onEvent({
        type: "section_revised",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>revised</p>", aiGenerated: true },
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toBe("<p>revised</p>");
  });

  it("replaces state wholesale with the persisted rows on the final done event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: OnEvent) => {
      onEvent({
        type: "section_complete",
        sectionType: "EXECUTIVE_SUMMARY",
        section: { type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>draft</p>", aiGenerated: true },
        index: 1, total: 1,
      });
      onEvent({
        type: "done",
        success: true,
        completed: 1,
        total: 1,
        sections: [{ id: "sec-real-id", type: "EXECUTIVE_SUMMARY", title: "Executive Summary", content: "<p>final</p>", aiGenerated: true, sortOrder: 1 }],
      });
    });

    const { deps, getSections } = makeDeps();
    await createGenerateAll(deps)();

    const sections = getSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe("sec-real-id");
    expect(sections[0].content).toBe("<p>final</p>");
  });

  it("updates the status line through section_start, critique_start, and clears it when done", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: OnEvent) => {
      onEvent({ type: "section_start", sectionType: "EXECUTIVE_SUMMARY", index: 1, total: 1 });
      onEvent({ type: "critique_start" });
      onEvent({ type: "done", success: true, completed: 1, total: 1, sections: [] });
    });

    const { deps, setGenerationStatus } = makeDeps();
    await createGenerateAll(deps)();

    const calls = setGenerationStatus.mock.calls.map((c: unknown[]) => c[0] as string | null);
    expect(calls.some((s) => s?.includes("executive summary"))).toBe(true);
    expect(calls).toContain("Reviewing memo quality...");
    expect(calls[calls.length - 1]).toBeNull(); // cleared in finally
  });

  it("sets an error on an error event", async () => {
    streamMock.mockImplementation(async (_path: string, _body: unknown, onEvent: OnEvent) => {
      onEvent({ type: "error", message: "LLM is not available. Check API key configuration." });
    });
    const { deps, setError } = makeDeps();
    await createGenerateAll(deps)();
    expect(setError).toHaveBeenCalledWith("LLM is not available. Check API key configuration.");
  });

  it("sets generatingAll(true) then (false) around the call, and clears generationStatus in finally", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps, setGeneratingAll, setGenerationStatus } = makeDeps();
    await createGenerateAll(deps)();
    expect(setGeneratingAll).toHaveBeenNthCalledWith(1, true);
    expect(setGeneratingAll).toHaveBeenLastCalledWith(false);
    expect(setGenerationStatus).toHaveBeenLastCalledWith(null);
  });
});

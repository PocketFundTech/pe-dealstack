import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendPrompt, type SendPromptDeps } from "./deal-page-handlers";
import type { ChatMessage } from "./components";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: {} }) }));

const streamMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: { stream: (...args: unknown[]) => streamMock(...args) } }));

function makeDeps() {
  let messages: ChatMessage[] = [];
  const setMessages = vi.fn((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    messages = updater(messages);
  }) as unknown as SendPromptDeps["setMessages"];
  const setChatSending = vi.fn() as unknown as SendPromptDeps["setChatSending"];
  const showToast = vi.fn() as unknown as SendPromptDeps["showToast"];
  const loadDeal = vi.fn(async () => {});
  const deps: SendPromptDeps = { dealId: "deal-1", chatSending: false, setChatSending, setMessages, showToast, loadDeal };
  return {
    deps,
    getMessages: () => messages,
    setChatSending: setChatSending as unknown as ReturnType<typeof vi.fn>,
    showToast: showToast as unknown as ReturnType<typeof vi.fn>,
    loadDeal,
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("sendPrompt (streaming)", () => {
  it("appends the user message immediately, then builds the assistant message incrementally from text_delta events", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "text_delta", text: "Hello" });
      onEvent({ type: "text_delta", text: " there" });
      onEvent({ type: "done", response: "Hello there", model: "claude-sonnet-5", truncated: false });
    });

    const { deps, getMessages } = makeDeps();
    await sendPrompt("hi", deps);

    const messages = getMessages();
    expect(messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Hello there", streaming: false });
  });

  it("sends the last 10 prior messages as history, excluding the new message being sent", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps } = makeDeps();
    deps.setMessages((prev) => [
      ...prev,
      { id: "1", role: "user", content: "first" },
      { id: "2", role: "assistant", content: "reply" },
    ]);

    await sendPrompt("second question", deps);

    const [, body] = streamMock.mock.calls[0];
    expect(body).toEqual({
      message: "second question",
      history: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
    });
  });

  it("shows the tool's label as placeholder content, then replaces it with the first text_delta", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "tool_start", tool: "get_deal_financials", label: "Pulling financials..." });
      onEvent({ type: "text_delta", text: "Revenue is $10M" });
      onEvent({ type: "done", response: "Revenue is $10M", model: "claude-sonnet-5", truncated: false });
    });
    const { deps, getMessages } = makeDeps();
    await sendPrompt("what's our revenue?", deps);

    const assistantMsg = getMessages().find((m) => m.role === "assistant");
    // Final content is the streamed answer, not the tool label — the label
    // is a placeholder only, replaced (not appended to) by the first delta.
    expect(assistantMsg?.content).toBe("Revenue is $10M");
  });

  it("shows a toast and refreshes the deal on an update event", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "text_delta", text: "ok" });
      onEvent({ type: "update", update: { field: "stage", value: "DUE_DILIGENCE" } });
      onEvent({ type: "done", response: "ok", model: "claude-sonnet-5", truncated: false });
    });
    const { deps, showToast, loadDeal } = makeDeps();
    await sendPrompt("advance the deal", deps);

    expect(showToast).toHaveBeenCalledWith("Changes have been applied", "success", { title: "Deal Updated" });
    expect(loadDeal).toHaveBeenCalled();
  });

  it("appends an error-styled message and marks streaming false on an error event with no prior text", async () => {
    streamMock.mockImplementation(async (_path, _body, onEvent) => {
      onEvent({ type: "error", message: "Response timed out after 30000ms. Please try again." });
    });
    const { deps, getMessages } = makeDeps();
    await sendPrompt("hi", deps);

    const assistantMsg = getMessages().find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("⚠️");
    expect(assistantMsg?.content).toContain("Response timed out");
  });

  it("sets setChatSending(true) then setChatSending(false) around the call", async () => {
    streamMock.mockImplementation(async () => {});
    const { deps, setChatSending } = makeDeps();
    await sendPrompt("hi", deps);
    expect(setChatSending).toHaveBeenNthCalledWith(1, true);
    expect(setChatSending).toHaveBeenLastCalledWith(false);
  });
});

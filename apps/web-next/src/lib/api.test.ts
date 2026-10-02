import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We mock @/lib/supabase/client BEFORE importing the API module so the
// auth-fetching path uses our stubs. The session/token wiring is tested by
// the calls we make through the api object.
const getUserMock = vi.fn();
const getSessionMock = vi.fn();
const refreshSessionMock = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: getUserMock,
      getSession: getSessionMock,
      refreshSession: refreshSessionMock,
    },
  }),
}));

import { api, ApiError, NotFoundError } from "./api";

describe("api wrapper", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocation: Location;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocation = window.location;
    // jsdom locks window.location.href setter sometimes — replace the whole
    // object with a writable stub so the 401 redirect path can be observed.
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "/", pathname: "/deals/d1", search: "" } as Location,
    });

    // default: authenticated user with a token
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "test-token" } },
    });
    // Default: refreshing the session fails, so a 401 falls through to the
    // /login redirect instead of silently retrying forever.
    refreshSessionMock.mockResolvedValue({ data: { session: null }, error: new Error("no session") });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "location", { writable: true, value: originalLocation });
    vi.restoreAllMocks();
    getUserMock.mockReset();
    getSessionMock.mockReset();
    refreshSessionMock.mockReset();
  });

  it("prefixes the path with /api and forwards a Bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await api.get<{ ok: boolean }>("/deals");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/deals");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("throws NotFoundError on 404 instead of a generic Error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 404 })) as unknown as typeof fetch;

    await expect(api.get("/missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("redirects to /login on 401", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(api.get("/secure")).rejects.toThrow("Unauthorized");
    // A silent session-refresh is tried first (see the next test); once that
    // fails too, the redirect carries `next` so re-login returns the user to
    // what they were doing instead of always landing on /dashboard.
    expect(window.location.href).toBe("/login?next=%2Fdeals%2Fd1");
  });

  it("retries once after a silent session refresh succeeds, instead of redirecting", async () => {
    refreshSessionMock.mockResolvedValue({ data: { session: { access_token: "fresh-token" } }, error: null });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await api.get<{ ok: boolean }>("/secure");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.href).toBe("/"); // never redirected
  });

  it("posts the body as JSON with method=POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "d1" }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await api.post<{ id: string }>("/deals", { name: "Acme" });

    expect(result).toEqual({ id: "d1" });
    const [, init] = fetchMock.mock.calls[0];
    const opts = init as RequestInit;
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe(JSON.stringify({ name: "Acme" }));
  });

  it("returns undefined on 204 without parsing body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;

    const result = await api.delete<undefined>("/deals/d1");
    expect(result).toBeUndefined();
  });

  it("api.stream parses SSE data lines and calls onEvent for each", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"tool_start","tool":"search_documents"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"text_delta","text":"Hi"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"done","response":"Hi"}\n\n'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events: unknown[] = [];
    await api.stream("/deals/d1/chat", { message: "hi" }, (e) => events.push(e));

    expect(events).toEqual([
      { type: "tool_start", tool: "search_documents" },
      { type: "text_delta", text: "Hi" },
      { type: "done", response: "Hi" },
    ]);
  });

  it("api.stream synthesizes events from a legacy JSON response (engine flag off)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ response: "buffered answer", model: "gpt-4o", updates: [{ field: "stage" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const events: Record<string, unknown>[] = [];
    await api.stream("/deals/d1/chat", { message: "hi" }, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "text_delta", text: "buffered answer" });
    expect(events[1]).toEqual({ type: "update", update: { field: "stage" } });
    expect(events[events.length - 1]).toMatchObject({ type: "done", response: "buffered answer" });
  });

  it("api.stream handles an SSE frame split across two chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text_'));
        controller.enqueue(encoder.encode('delta","text":"ok"}\n\n'));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const events: unknown[] = [];
    await api.stream("/deals/d1/chat", { message: "hi" }, (e) => events.push(e));

    expect(events).toEqual([{ type: "text_delta", text: "ok" }]);
  });

  it("api.stream throws ApiError before reading the body when the response is non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(api.stream("/deals/d1/chat", { message: "hi" }, () => {})).rejects.toThrow("boom");
  });

  // The Express error handler answers { error: { code, message } }. The
  // wrapper used to JSON.stringify that object, so users saw toasts like
  // {"code":"INTERNAL_ERROR","message":"..."} and the code was lost.
  describe("nested { error: { code, message } } bodies", () => {
    const nested = () =>
      new Response(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "Name is required" } }), { status: 400 });
    const caught = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as ApiError);

    it("api.get surfaces the message and code, not raw JSON", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(nested()) as unknown as typeof fetch;
      const err = await caught(api.get("/deals"));
      expect(err.message).toBe("Name is required");
      expect(err.code).toBe("VALIDATION_ERROR");
    });

    it("api.stream surfaces the message and code", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(nested()) as unknown as typeof fetch;
      const err = await caught(api.stream("/deals/d1/chat", { message: "hi" }, () => {}));
      expect(err.message).toBe("Name is required");
      expect(err.code).toBe("VALIDATION_ERROR");
    });

    it("api.postStream surfaces the message and code", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(nested()) as unknown as typeof fetch;
      const err = await caught(api.postStream("/memos/m1/generate", {}, () => {}));
      expect(err.message).toBe("Name is required");
      expect(err.code).toBe("VALIDATION_ERROR");
    });
  });

  it("api.stream throws NotFoundError on 404, same contract as api.get/post", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(api.stream("/deals/d1/chat", { message: "hi" }, () => {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

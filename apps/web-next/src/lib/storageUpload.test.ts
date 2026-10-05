import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same mocking pattern as api.test.ts: stub the supabase browser client
// before importing the module under test. getSession backs api.post's auth
// header; storage.from().uploadToSignedUrl backs the actual byte upload.
const getSessionMock = vi.fn();
const uploadToSignedUrlMock = vi.fn();
const fromMock = vi.fn(() => ({ uploadToSignedUrl: uploadToSignedUrlMock }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: getSessionMock },
    storage: { from: fromMock },
  }),
}));

import {
  uploadViaSignedUrl,
  FileTooLargeError,
  INGEST_MAX_FILE_SIZE,
  DATA_ROOM_MAX_FILE_SIZE,
  runWithConcurrency,
} from "./storageUpload";

function makeFile(name: string, size: number, type = "application/pdf"): File {
  const file = new File([new Uint8Array(1)], name, { type });
  // jsdom's File doesn't let us construct arbitrary-size blobs cheaply —
  // override `size` directly, same trick used elsewhere for large-file tests.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("uploadViaSignedUrl", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    getSessionMock.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
    uploadToSignedUrlMock.mockReset();
    fromMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    getSessionMock.mockReset();
  });

  it("rejects a file over the ingest limit client-side, before any network call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const file = makeFile("big-cim.pdf", INGEST_MAX_FILE_SIZE + 1);

    await expect(uploadViaSignedUrl(file, { purpose: "ingest" })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadToSignedUrlMock).not.toHaveBeenCalled();
  });

  it("allows a data-room upload up to the larger 100MB limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ storagePath: "org/deal/file.pdf", token: "tok", signedUrl: "https://x" }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    uploadToSignedUrlMock.mockResolvedValue({ data: { path: "org/deal/file.pdf" }, error: null });

    const file = makeFile("big-model.xlsx", DATA_ROOM_MAX_FILE_SIZE - 1);
    const result = await uploadViaSignedUrl(file, { purpose: "data-room", dealId: "deal-1" });

    expect(result.storagePath).toBe("org/deal/file.pdf");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a data-room file over 100MB client-side", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const file = makeFile("huge.pdf", DATA_ROOM_MAX_FILE_SIZE + 1);

    await expect(uploadViaSignedUrl(file, { purpose: "data-room" })).rejects.toBeInstanceOf(FileTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls sign then uploadToSignedUrl with the returned path/token, then returns metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ storagePath: "org1/deal1/cim.pdf", token: "signed-token", signedUrl: "https://storage/x" }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    uploadToSignedUrlMock.mockResolvedValue({ data: { path: "org1/deal1/cim.pdf" }, error: null });

    const file = makeFile("cim.pdf", 1024, "application/pdf");
    const meta = await uploadViaSignedUrl(file, { purpose: "ingest" });

    // sign call
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/uploads/sign");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ fileName: "cim.pdf", contentType: "application/pdf", size: 1024, purpose: "ingest" });

    // upload call
    expect(fromMock).toHaveBeenCalledWith("documents");
    expect(uploadToSignedUrlMock).toHaveBeenCalledWith(
      "org1/deal1/cim.pdf",
      "signed-token",
      file,
      expect.objectContaining({ contentType: "application/pdf" }),
    );

    expect(meta).toEqual({
      storagePath: "org1/deal1/cim.pdf",
      fileName: "cim.pdf",
      mimeType: "application/pdf",
      size: 1024,
    });
  });

  it("includes dealId in the sign request when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ storagePath: "p", token: "t", signedUrl: "u" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    uploadToSignedUrlMock.mockResolvedValue({ data: {}, error: null });

    const file = makeFile("notes.pdf", 100);
    await uploadViaSignedUrl(file, { purpose: "ingest", dealId: "deal-42" });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.dealId).toBe("deal-42");
  });

  it("surfaces a 413 from the sign endpoint with the server's message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "File exceeds the 50MB ingest limit" }), { status: 413 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const file = makeFile("edge.pdf", 1000);
    await expect(uploadViaSignedUrl(file, { purpose: "ingest" })).rejects.toThrow(
      "File exceeds the 50MB ingest limit",
    );
  });

  it("throws the storage client's error message when uploadToSignedUrl fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ storagePath: "p", token: "t", signedUrl: "u" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    uploadToSignedUrlMock.mockResolvedValue({ data: null, error: { message: "token expired" } });

    const file = makeFile("cim.pdf", 100);
    await expect(uploadViaSignedUrl(file, { purpose: "ingest" })).rejects.toThrow("token expired");
  });

  it("calls onStep('signing') then onStep('uploading') in order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ storagePath: "p", token: "t", signedUrl: "u" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    uploadToSignedUrlMock.mockResolvedValue({ data: {}, error: null });

    const steps: string[] = [];
    const file = makeFile("cim.pdf", 100);
    await uploadViaSignedUrl(file, { purpose: "ingest", onStep: (s) => steps.push(s) });

    expect(steps).toEqual(["signing", "uploading"]);
  });
});

describe("runWithConcurrency", () => {
  it("runs at most `concurrency` tasks in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await runWithConcurrency(items, 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3, 4], 3, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });
});

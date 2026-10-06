import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the JSON API layer so we can assert exactly what body each handler
// sends, without a real network. uploadViaSignedUrl is mocked too — its own
// behavior (sign -> upload) is covered by storageUpload.test.ts; here we
// only care that the handler calls it with the right purpose/dealId and
// forwards its result as the JSON follow-up.
const apiPostMock = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...args: unknown[]) => apiPostMock(...args) },
}));

const uploadViaSignedUrlMock = vi.fn();
vi.mock("@/lib/storageUpload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storageUpload")>("@/lib/storageUpload");
  return {
    ...actual,
    uploadViaSignedUrl: (...args: unknown[]) => uploadViaSignedUrlMock(...args),
  };
});

import { createHandleUploadFiles, createHandleUploadDirect } from "./uploadHandlers";
import type { FileUploadItem } from "@/app/(app)/deal-intake/tab-panels";

function makeFileItem(name: string): FileUploadItem {
  return { file: new File(["x"], name, { type: "application/pdf" }), status: "pending" };
}

function makeUploadFilesDeps(overrides: Partial<Parameters<typeof createHandleUploadFiles>[0]> = {}) {
  return {
    files: [],
    mode: "new" as const,
    selectedDeal: null,
    setError: vi.fn(),
    setWarning: vi.fn(),
    setResult: vi.fn(),
    setFiles: vi.fn(),
    setProgressMessage: vi.fn(),
    beginProcessing: vi.fn(),
    endProcessing: vi.fn(),
    fireFollowUp: vi.fn(),
    maybeShowTeaserPopup: vi.fn(),
    ...overrides,
  };
}

describe("createHandleUploadFiles", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    uploadViaSignedUrlMock.mockReset();
  });

  it("sends the JSON follow-up with storagePath + every field the old FormData carried", async () => {
    uploadViaSignedUrlMock.mockResolvedValue({
      storagePath: "org1/deal1/cim.pdf",
      fileName: "cim.pdf",
      mimeType: "application/pdf",
      size: 1234,
    });
    apiPostMock.mockResolvedValue({ deal: { id: "deal-1", name: "Acme" } });

    const deps = makeUploadFilesDeps({ files: [makeFileItem("cim.pdf")] });
    await createHandleUploadFiles(deps)();

    expect(uploadViaSignedUrlMock).toHaveBeenCalledWith(
      deps.files[0].file,
      expect.objectContaining({ purpose: "ingest" }),
    );
    expect(apiPostMock).toHaveBeenCalledWith("/ingest", {
      storagePath: "org1/deal1/cim.pdf",
      fileName: "cim.pdf",
      mimeType: "application/pdf",
      size: 1234,
    });
  });

  it("keeps merges sequential: file 1 waits for file 0's dealId and carries it in the follow-up", async () => {
    const callOrder: string[] = [];
    uploadViaSignedUrlMock.mockImplementation(async (file: File) => {
      callOrder.push(`upload:${file.name}`);
      return { storagePath: `p/${file.name}`, fileName: file.name, mimeType: "application/pdf", size: 10 };
    });
    apiPostMock.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      callOrder.push(`post:${path}:${body.dealId ?? "none"}`);
      if (path === "/ingest" && !body.dealId) {
        return { deal: { id: "deal-created", name: "Acme" } };
      }
      return { deal: { id: "deal-created", name: "Acme" } };
    });

    const deps = makeUploadFilesDeps({
      files: [makeFileItem("cim.pdf"), makeFileItem("teaser.pdf")],
    });
    await createHandleUploadFiles(deps)();

    expect(callOrder).toEqual([
      "upload:cim.pdf",
      "post:/ingest:none",
      "upload:teaser.pdf",
      "post:/ingest:deal-created",
    ]);
    // The second file's JSON follow-up carries the dealId created by the first.
    expect(apiPostMock.mock.calls[1][1]).toMatchObject({ dealId: "deal-created" });
  });

  it("one file failing doesn't abort the rest of the batch", async () => {
    uploadViaSignedUrlMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ storagePath: "p/b.pdf", fileName: "b.pdf", mimeType: "application/pdf", size: 5 });
    apiPostMock.mockResolvedValue({ deal: { id: "deal-2", name: "Beta" } });

    const setFiles = vi.fn();
    const deps = makeUploadFilesDeps({
      files: [makeFileItem("a.pdf"), makeFileItem("b.pdf")],
      setFiles,
    });
    await createHandleUploadFiles(deps)();

    // Second file still uploaded despite the first one's failure.
    expect(uploadViaSignedUrlMock).toHaveBeenCalledTimes(2);
    expect(deps.setResult).toHaveBeenCalledWith({ deal: { id: "deal-2", name: "Beta" } });
  });

  it("when the first file fails, the next one creates the deal and the rest join it (no deal per file)", async () => {
    uploadViaSignedUrlMock.mockImplementation(async (file: File) => (
      { storagePath: `p/${file.name}`, fileName: file.name, mimeType: "application/pdf", size: 10 }
    ));
    const posts: Array<string> = [];
    apiPostMock.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      posts.push(`${body.fileName}:${body.dealId ?? "new"}`);
      if (body.fileName === "cim.pdf") throw new Error("AI service rejected the request");
      return { deal: { id: "deal-csp", name: "Community Solar Platform" } };
    });

    const deps = makeUploadFilesDeps({
      files: [makeFileItem("cim.pdf"), makeFileItem("transcript.pdf"), makeFileItem("letter.pdf"), makeFileItem("msa.pdf")],
    });
    await createHandleUploadFiles(deps)();

    expect(posts).toEqual(["cim.pdf:new", "transcript.pdf:new", "letter.pdf:deal-csp", "msa.pdf:deal-csp"]);
    expect(deps.maybeShowTeaserPopup).toHaveBeenCalledWith({ id: "deal-csp", name: "Community Solar Platform" });
  });

  it("routes an existing-mode upload to /ingest with the selected deal id", async () => {
    uploadViaSignedUrlMock.mockResolvedValue({
      storagePath: "p/model.xlsx", fileName: "model.xlsx", mimeType: "application/vnd.ms-excel", size: 99,
    });
    apiPostMock.mockResolvedValue({ deal: { id: "deal-9", name: "Existing Co" }, isUpdate: true });

    const deps = makeUploadFilesDeps({
      mode: "existing",
      selectedDeal: { id: "deal-9", name: "Existing Co" },
      files: [makeFileItem("model.xlsx")],
    });
    await createHandleUploadFiles(deps)();

    expect(uploadViaSignedUrlMock).toHaveBeenCalledWith(
      deps.files[0].file,
      expect.objectContaining({ purpose: "ingest", dealId: "deal-9" }),
    );
    expect(apiPostMock).toHaveBeenCalledWith("/ingest", expect.objectContaining({ dealId: "deal-9" }));
  });
});

describe("createHandleUploadDirect", () => {
  beforeEach(() => {
    apiPostMock.mockReset();
    uploadViaSignedUrlMock.mockReset();
  });

  it("uploads every file with purpose 'data-room' and posts the JSON follow-up per file", async () => {
    uploadViaSignedUrlMock.mockImplementation(async (file: File) => ({
      storagePath: `p/${file.name}`, fileName: file.name, mimeType: "application/pdf", size: 42,
    }));
    apiPostMock.mockResolvedValue({});

    const files = [makeFileItem("a.pdf"), makeFileItem("b.pdf"), makeFileItem("c.pdf"), makeFileItem("d.pdf")];
    const deps = {
      files,
      selectedDeal: { id: "deal-1", name: "Acme" },
      setError: vi.fn(),
      setResult: vi.fn(),
      setFiles: vi.fn(),
      setProgressMessage: vi.fn(),
      beginProcessing: vi.fn(),
      endProcessing: vi.fn(),
    };
    await createHandleUploadDirect(deps)();

    expect(uploadViaSignedUrlMock).toHaveBeenCalledTimes(4);
    for (const call of uploadViaSignedUrlMock.mock.calls) {
      expect(call[1]).toMatchObject({ purpose: "data-room", dealId: "deal-1" });
    }
    expect(apiPostMock).toHaveBeenCalledTimes(4);
    expect(apiPostMock).toHaveBeenCalledWith("/deals/deal-1/documents", expect.objectContaining({ storagePath: "p/a.pdf" }));
  });

  it("runs at most 3 uploads concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    uploadViaSignedUrlMock.mockImplementation(async (file: File) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { storagePath: `p/${file.name}`, fileName: file.name, mimeType: "application/pdf", size: 1 };
    });
    apiPostMock.mockResolvedValue({});

    const files = Array.from({ length: 6 }, (_, i) => makeFileItem(`f${i}.pdf`));
    const deps = {
      files,
      selectedDeal: { id: "deal-1", name: "Acme" },
      setError: vi.fn(),
      setResult: vi.fn(),
      setFiles: vi.fn(),
      setProgressMessage: vi.fn(),
      beginProcessing: vi.fn(),
      endProcessing: vi.fn(),
    };
    await createHandleUploadDirect(deps)();

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("surfaces a per-file error via setFiles instead of aborting the batch", async () => {
    uploadViaSignedUrlMock
      .mockResolvedValueOnce({ storagePath: "p/a.pdf", fileName: "a.pdf", mimeType: "application/pdf", size: 1 })
      .mockRejectedValueOnce(new Error("too large"));
    apiPostMock.mockResolvedValue({});

    const setResult = vi.fn();
    const setError = vi.fn();
    const deps = {
      files: [makeFileItem("a.pdf"), makeFileItem("b.pdf")],
      selectedDeal: { id: "deal-1", name: "Acme" },
      setError,
      setResult,
      setFiles: vi.fn(),
      setProgressMessage: vi.fn(),
      beginProcessing: vi.fn(),
      endProcessing: vi.fn(),
    };
    await createHandleUploadDirect(deps)();

    // At least one succeeded, so the batch is reported as a partial success,
    // not a hard error.
    expect(setResult).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});

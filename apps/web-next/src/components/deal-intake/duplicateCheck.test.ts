import { describe, it, expect, vi, beforeEach } from "vitest";

// Duplicate check on intake: the first file that could CREATE a deal asks the
// user when the server finds a likely existing deal; the answer covers the
// whole batch, and Cancel creates nothing.
const apiPostMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: { post: (...args: unknown[]) => apiPostMock(...args) } }));
vi.mock("@/lib/appEvents", () => ({ emitDealsChanged: () => {} }));
const uploadViaSignedUrlMock = vi.fn();
vi.mock("@/lib/storageUpload", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storageUpload")>("@/lib/storageUpload");
  return { ...actual, uploadViaSignedUrl: (...args: unknown[]) => uploadViaSignedUrlMock(...args) };
});

import { createHandleUploadFiles, createHandleExtractText } from "./uploadHandlers";
import { sendWithDuplicateCheck, type DuplicateCheck } from "./duplicateCheck";
import type { FileUploadItem } from "@/app/(app)/deal-intake/tab-panels";

const CHECK: DuplicateCheck = {
  candidates: [{ id: "deal-csp", name: "Community Solar Platform", companyName: "Community Solar Platform Holdings", reason: "similar" }],
  extractedCompanyName: "CSP",
};
const item = (name: string): FileUploadItem => ({ file: new File(["x"], name, { type: "application/pdf" }), status: "pending" });

function deps(overrides: Partial<Parameters<typeof createHandleUploadFiles>[0]> = {}) {
  return {
    files: [item("cim.pdf"), item("teaser.pdf")],
    mode: "new" as const,
    selectedDeal: null,
    setError: vi.fn(), setWarning: vi.fn(), setResult: vi.fn(), setFiles: vi.fn(), setProgressMessage: vi.fn(),
    beginProcessing: vi.fn(), endProcessing: vi.fn(), fireFollowUp: vi.fn(), maybeShowTeaserPopup: vi.fn(),
    ...overrides,
  };
}

/** Server double: a request with no dealId / forceCreate gets the duplicate prompt. */
function serverAsksFirst() {
  apiPostMock.mockImplementation(async (_path: string, body: Record<string, unknown>) => {
    if (body.checkDuplicates && !body.dealId && !body.forceCreate) return { success: true, duplicateCheck: CHECK, extractionToken: "tok-1" };
    if (body.dealId) return { deal: { id: body.dealId, name: "Community Solar Platform" }, isUpdate: true };
    return { deal: { id: "deal-new", name: "CSP" } };
  });
}

beforeEach(() => {
  apiPostMock.mockReset();
  uploadViaSignedUrlMock.mockReset();
  uploadViaSignedUrlMock.mockImplementation(async (file: File) => ({ storagePath: `p/${file.name}`, fileName: file.name, mimeType: "application/pdf", size: 1 }));
});

describe("file batch in New deal mode", () => {
  it("pauses on the first file, and 'Add to <deal>' sends the whole batch to that deal", async () => {
    serverAsksFirst();
    const askDuplicate = vi.fn(async () => ({ action: "add" as const, dealId: "deal-csp", dealName: "Community Solar Platform" }));
    const d = deps({ askDuplicate });
    await createHandleUploadFiles(d)();

    expect(askDuplicate).toHaveBeenCalledWith(CHECK);
    const bodies = apiPostMock.mock.calls.map(([path, body]) => ({ path, ...body }));
    expect(bodies).toEqual([
      expect.objectContaining({ path: "/ingest", fileName: "cim.pdf", checkDuplicates: true }),
      expect.objectContaining({ path: "/ingest", fileName: "cim.pdf", dealId: "deal-csp", extractionToken: "tok-1" }),
      expect.objectContaining({ path: "/ingest", fileName: "teaser.pdf", dealId: "deal-csp" }),
    ]);
    expect(bodies[1]).not.toHaveProperty("checkDuplicates");
    expect(bodies[2]).not.toHaveProperty("checkDuplicates");
    // Re-uploaded for the resend (the server cleans the staging copy after each response).
    expect(uploadViaSignedUrlMock).toHaveBeenCalledTimes(3);
    expect(d.maybeShowTeaserPopup).not.toHaveBeenCalled();
    expect(d.setResult).toHaveBeenCalledWith(expect.objectContaining({ isUpdate: true }));
  });

  it("'Create a new deal anyway' resends with forceCreate + token and the rest join the new deal", async () => {
    serverAsksFirst();
    const d = deps({ askDuplicate: async () => ({ action: "create" as const }) });
    await createHandleUploadFiles(d)();

    const bodies = apiPostMock.mock.calls.map(([, body]) => body);
    expect(bodies[1]).toMatchObject({ fileName: "cim.pdf", forceCreate: true, extractionToken: "tok-1" });
    expect(bodies[2]).toMatchObject({ fileName: "teaser.pdf", dealId: "deal-new" });
    expect(apiPostMock).toHaveBeenCalledTimes(3);
    expect(d.maybeShowTeaserPopup).toHaveBeenCalledWith({ id: "deal-new", name: "CSP" });
  });

  it("Cancel stops the batch: nothing else is sent, no error, files back to pending", async () => {
    serverAsksFirst();
    const d = deps({ askDuplicate: async () => ({ action: "cancel" as const }) });
    await createHandleUploadFiles(d)();

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(uploadViaSignedUrlMock).toHaveBeenCalledTimes(1);
    expect(d.setError).not.toHaveBeenCalled();
    expect(d.setResult).not.toHaveBeenCalled();
    expect(d.endProcessing).toHaveBeenCalled();
    const lastUpdate = vi.mocked(d.setFiles).mock.calls.at(-1)![0] as (prev: FileUploadItem[]) => FileUploadItem[];
    expect(lastUpdate([{ ...item("cim.pdf"), status: "uploading", message: "Possible duplicate" }, item("teaser.pdf")]).map((f) => f.status))
      .toEqual(["pending", "pending"]);
  });

  it("no likely duplicate: one request per file, no prompt", async () => {
    apiPostMock.mockResolvedValue({ deal: { id: "deal-new", name: "CSP" } });
    const askDuplicate = vi.fn();
    await createHandleUploadFiles(deps({ askDuplicate }))();
    expect(askDuplicate).not.toHaveBeenCalled();
    expect(apiPostMock).toHaveBeenCalledTimes(2);
  });

  it("Update Existing Deal mode never asks", async () => {
    apiPostMock.mockResolvedValue({ deal: { id: "deal-9", name: "X" }, isUpdate: true });
    await createHandleUploadFiles(deps({ mode: "existing", selectedDeal: { id: "deal-9", name: "X" }, askDuplicate: vi.fn() }))();
    for (const [, body] of apiPostMock.mock.calls) expect(body).not.toHaveProperty("checkDuplicates");
  });
});

describe("paste text", () => {
  const textDeps = (askDuplicate: Parameters<typeof createHandleExtractText>[0]["askDuplicate"]) => ({
    textInput: "CSP is raising growth equity; community solar developer with 500 staff across 12 states.",
    textSourceType: "email",
    mode: "new" as const,
    selectedDeal: null,
    setError: vi.fn(), setResult: vi.fn(), beginProcessing: vi.fn(), endProcessing: vi.fn(),
    fireFollowUp: vi.fn(), maybeShowTeaserPopup: vi.fn(), askDuplicate,
  });

  it("'Add to <deal>' resends the text with the chosen dealId and the token", async () => {
    serverAsksFirst();
    const d = textDeps(async () => ({ action: "add", dealId: "deal-csp", dealName: "Community Solar Platform" }));
    await createHandleExtractText(d)();
    expect(apiPostMock.mock.calls[1]).toEqual(["/ingest/text", expect.objectContaining({ dealId: "deal-csp", extractionToken: "tok-1", sourceType: "email" })]);
    expect(d.setResult).toHaveBeenCalledWith(expect.objectContaining({ isUpdate: true }));
    expect(d.maybeShowTeaserPopup).not.toHaveBeenCalled();
  });

  it("Cancel creates nothing and shows no error", async () => {
    serverAsksFirst();
    const d = textDeps(async () => ({ action: "cancel" }));
    await createHandleExtractText(d)();
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(d.setResult).not.toHaveBeenCalled();
    expect(d.setError).not.toHaveBeenCalled();
    expect(d.endProcessing).toHaveBeenCalled();
  });
});

describe("sendWithDuplicateCheck", () => {
  it("without an ask function it sends once with no check (old behaviour)", async () => {
    const send = vi.fn(async (): Promise<{ deal: { id: string }; duplicateCheck?: DuplicateCheck }> => ({ deal: { id: "d" } }));
    const out = await sendWithDuplicateCheck(send, undefined);
    expect(send).toHaveBeenCalledWith({});
    expect(out).toEqual({ cancelled: false, data: { deal: { id: "d" } }, decision: null });
  });
});

/**
 * Data-room actions used to fail silently: delete / rename / new folder closed
 * the dialog and nothing changed, the missing-document "Request" button gave
 * no feedback either way, and "Generate insights" only logged errors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const vdr = vi.hoisted(() => ({
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteDocument: vi.fn(),
  renameDocument: vi.fn(),
  requestDocument: vi.fn(),
  generateInsights: vi.fn(),
}));
vi.mock("@/lib/vdr/api", () => ({
  ...vdr,
  transformFolder: (f: unknown) => f,
  transformInsights: (i: unknown) => i,
}));

import {
  createCreateFolder,
  createConfirmDeleteFolder,
  createRenameFolder,
  createConfirmDeleteFile,
  createRenameFile,
  createRequestDocument,
  createGenerateInsights,
} from "./file-handlers";

const showToast = vi.fn();
const noop = vi.fn();

function folderDeps() {
  return {
    dealId: "d1", folders: [{ id: "f1", name: "Legal", fileCount: 0 }] as never, activeFolderId: "f1",
    newFolderName: "Tax", creatingFolder: false,
    setFolders: noop, setActiveFolderId: noop, setShowCreateFolder: noop, setNewFolderName: noop,
    setCreatingFolder: noop, setAllFiles: noop, setPendingDelete: noop, showToast,
  };
}
function fileDeps() {
  return { dealId: "d1", allFiles: [{ id: "x1", name: "cim.pdf" }] as never, setAllFiles: noop, setFolders: noop, setPendingDelete: noop, showToast };
}
function insightsDeps() {
  return {
    dealId: "d1", activeFolderId: "f1", generating: false,
    activeFolder: { id: "f1", name: "Legal" } as never,
    activeFolderInsights: { missingDocuments: [{ id: "m1", name: "Cap table" }] } as never,
    setInsights: noop, setFolders: noop, setGenerating: noop, showToast,
  };
}

beforeEach(() => {
  showToast.mockReset();
  Object.values(vdr).forEach((f) => f.mockReset());
});

describe("data-room actions tell the user when they fail", () => {
  it("create folder", async () => {
    vdr.createFolder.mockResolvedValue(null);
    await createCreateFolder(folderDeps())();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't create"), "error");
  });

  it("delete folder", async () => {
    vdr.deleteFolder.mockResolvedValue(false);
    await createConfirmDeleteFolder(folderDeps())("f1");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't delete"), "error");
  });

  it("rename folder", async () => {
    vdr.renameFolder.mockResolvedValue(false);
    await createRenameFolder(folderDeps())("f1", "New");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't rename"), "error");
  });

  it("delete file", async () => {
    vdr.deleteDocument.mockResolvedValue(false);
    await createConfirmDeleteFile(fileDeps())("x1");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't delete"), "error");
  });

  it("rename file", async () => {
    vdr.renameDocument.mockResolvedValue(false);
    await createRenameFile(fileDeps())("x1", "new.pdf");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't rename"), "error");
  });

  it("generate insights", async () => {
    vdr.generateInsights.mockRejectedValue(new Error("AI provider unavailable"));
    await createGenerateInsights(insightsDeps())();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("AI provider unavailable"), "error");
  });
});

describe("requesting a missing document", () => {
  it("confirms the request was sent", async () => {
    vdr.requestDocument.mockResolvedValue({});
    await createRequestDocument(insightsDeps())("m1");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Cap table"), "success");
  });

  it("says when the request failed", async () => {
    vdr.requestDocument.mockRejectedValue(new Error("No contact email"));
    await createRequestDocument(insightsDeps())("m1");
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("No contact email"), "error");
  });
});

// File/folder action handlers extracted from page.tsx so the page itself
// stays under the 500-line cap. Each function is a factory that closes over
// the dependencies it needs and returns the async handler. Behavior is
// unchanged — same API calls, same state mutations.

import type { Dispatch, SetStateAction } from "react";
import {
  analyzeDocument,
  createFolder,
  deleteDocument,
  deleteFolder,
  extractFinancials,
  fetchAllDeals,
  fetchDocuments,
  generateInsights,
  downloadDocument,
  linkDocumentToDeal,
  renameDocument,
  renameFolder,
  requestDocument,
  transformDocument,
  transformFolder,
  transformInsights,
  uploadDocument,
} from "@/lib/vdr/api";
import type { APIDocument, Folder, FolderInsights, VDRFile } from "@/lib/vdr/types";

type ToastFn = (message: string, type?: "success" | "error" | "info") => void;
type PendingDelete = { type: "folder" | "file"; id: string; name: string; extra?: string } | null;

// ─── Folder handlers ────────────────────────────────────────────────────

interface FolderDeps {
  dealId: string;
  folders: Folder[];
  activeFolderId: string | null;
  newFolderName: string;
  creatingFolder: boolean;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setActiveFolderId: Dispatch<SetStateAction<string | null>>;
  setShowCreateFolder: Dispatch<SetStateAction<boolean>>;
  setNewFolderName: Dispatch<SetStateAction<string>>;
  setCreatingFolder: Dispatch<SetStateAction<boolean>>;
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
  setPendingDelete: Dispatch<SetStateAction<PendingDelete>>;
}

export function createCreateFolder(deps: FolderDeps) {
  const {
    dealId, newFolderName, creatingFolder,
    setFolders, setActiveFolderId, setShowCreateFolder, setNewFolderName, setCreatingFolder,
  } = deps;
  return async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const created = await createFolder(dealId, name);
      if (created) {
        const folder = transformFolder(created);
        setFolders((prev) => [...prev, folder]);
        setActiveFolderId(folder.id);
        setShowCreateFolder(false);
        setNewFolderName("");
      }
    } finally {
      setCreatingFolder(false);
    }
  };
}

export function createDeleteFolder(deps: FolderDeps) {
  const { folders, setPendingDelete } = deps;
  return async (folderId: string) => {
    const folder = folders.find((f) => f.id === folderId);
    setPendingDelete({
      type: "folder",
      id: folderId,
      name: folder?.name || "folder",
      extra: (folder?.fileCount || 0) > 0
        ? `This folder contains ${folder?.fileCount} file(s) which will also be deleted.`
        : undefined,
    });
  };
}

export function createConfirmDeleteFolder(deps: FolderDeps) {
  const { folders, activeFolderId, setFolders, setAllFiles, setActiveFolderId } = deps;
  return async (folderId: string) => {
    const folder = folders.find((f) => f.id === folderId);

    const cascade = (folder?.fileCount || 0) > 0;
    const ok = await deleteFolder(folderId, cascade);
    if (!ok) return;
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    setAllFiles((prev) => prev.filter((f) => f.folderId !== folderId));
    if (activeFolderId === folderId) {
      const remaining = folders.filter((f) => f.id !== folderId);
      setActiveFolderId(remaining[0]?.id || null);
    }
  };
}

export function createRenameFolder(deps: Pick<FolderDeps, "setFolders">) {
  const { setFolders } = deps;
  return async (folderId: string, newName: string) => {
    const ok = await renameFolder(folderId, newName);
    if (!ok) return;
    setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, name: newName } : f)));
  };
}

// ─── File handlers ──────────────────────────────────────────────────────

interface FileDeps {
  dealId: string;
  allFiles: VDRFile[];
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setPendingDelete: Dispatch<SetStateAction<PendingDelete>>;
  showToast: ToastFn;
}

export function createDeleteFile(deps: FileDeps) {
  const { allFiles, setPendingDelete } = deps;
  return async (fileId: string) => {
    const file = allFiles.find((f) => f.id === fileId);
    setPendingDelete({ type: "file", id: fileId, name: file?.name || "file" });
  };
}

export function createConfirmDeleteFile(deps: FileDeps) {
  const { allFiles, setAllFiles, setFolders } = deps;
  return async (fileId: string) => {
    const file = allFiles.find((f) => f.id === fileId);
    const ok = await deleteDocument(fileId);
    if (!ok) return;
    setAllFiles((prev) => prev.filter((f) => f.id !== fileId));
    if (file?.folderId) {
      setFolders((prev) =>
        prev.map((f) =>
          f.id === file.folderId ? { ...f, fileCount: Math.max(0, f.fileCount - 1) } : f,
        ),
      );
    }
  };
}

export function createRenameFile(deps: Pick<FileDeps, "setAllFiles">) {
  const { setAllFiles } = deps;
  return async (fileId: string, newName: string) => {
    const ok = await renameDocument(fileId, newName);
    if (!ok) return;
    setAllFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, name: newName } : f)));
  };
}

// ─── Document actions (preview, analyze, financials, link) ──────────────

interface DocActionDeps {
  dealId: string;
  showToast: ToastFn;
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
}

export function createFileClick(deps: { showToast: ToastFn }) {
  const { showToast } = deps;
  return async (file: VDRFile) => {
    try {
      // PDFs come back from the API watermarked (viewer email + timestamp +
      // IP stamped on every page). Other file types pass through unchanged.
      // downloadDocument handles both response shapes.
      const ok = await downloadDocument(file.id, file.name);
      if (!ok) {
        showToast(`Unable to load document: ${file.name}`, "error");
      }
    } catch (err) {
      console.warn("[vdr] handleFileClick failed:", err);
      showToast(`Error loading file: ${file.name}`, "error");
    }
  };
}

export function createReanalyze(deps: DocActionDeps) {
  const { dealId, showToast, setAllFiles } = deps;
  return async (file: VDRFile) => {
    showToast(`Analyzing "${file.name}"...`, "info");
    try {
      await analyzeDocument(file.id);
      const docs = await fetchDocuments(dealId);
      setAllFiles(docs.map(transformDocument));
      showToast(`"${file.name}" analyzed successfully`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Analysis failed", "error");
    }
  };
}

export function createExtractFinancials(deps: { dealId: string; showToast: ToastFn }) {
  const { dealId, showToast } = deps;
  return async (file: VDRFile) => {
    showToast(`Extracting financials from "${file.name}"... This may take 30-90 seconds.`, "info");
    try {
      const result = await extractFinancials(dealId, file.id);
      const count = result?.result?.periodsStored ?? result?.stored ?? 0;
      showToast(`Financials extracted -- ${count} period${count !== 1 ? "s" : ""} stored`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Financial extraction failed", "error");
    }
  };
}

interface LinkDeps {
  dealId: string;
  linkModalFile: VDRFile | null;
  linkDeals: Array<{ id: string; name: string; industry?: string }>;
  showToast: ToastFn;
  setLinkModalFile: Dispatch<SetStateAction<VDRFile | null>>;
  setLinkDeals: Dispatch<SetStateAction<Array<{ id: string; name: string; industry?: string }>>>;
  setLinkSearchQuery: Dispatch<SetStateAction<string>>;
  setLinking: Dispatch<SetStateAction<boolean>>;
}

export function createLinkToDeal(deps: LinkDeps) {
  const { dealId, setLinkModalFile, setLinkSearchQuery, setLinkDeals } = deps;
  return async (file: VDRFile) => {
    setLinkModalFile(file);
    setLinkSearchQuery("");
    const deals = await fetchAllDeals();
    setLinkDeals(deals.filter((d) => d.id !== dealId));
  };
}

export function createConfirmLinkToDeal(deps: LinkDeps) {
  const { linkModalFile, linkDeals, showToast, setLinkModalFile, setLinking } = deps;
  return async (targetDealId: string) => {
    if (!linkModalFile) return;
    setLinking(true);
    try {
      await linkDocumentToDeal(linkModalFile.id, targetDealId);
      const targetDeal = linkDeals.find((d) => d.id === targetDealId);
      showToast(`"${linkModalFile.name}" linked to ${targetDeal?.name || "deal"}`, "success");
      setLinkModalFile(null);
    } catch (err) {
      showToast(`Failed to link document: ${err instanceof Error ? err.message : "Unknown error"}`, "error");
    }
    setLinking(false);
  };
}

// ─── Insights handlers ──────────────────────────────────────────────────

interface InsightsDeps {
  dealId: string;
  activeFolderId: string | null;
  generating: boolean;
  activeFolder: Folder | undefined;
  activeFolderInsights: FolderInsights | null | undefined;
  setInsights: Dispatch<SetStateAction<Record<string, FolderInsights>>>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setGenerating: Dispatch<SetStateAction<boolean>>;
}

export function createGenerateInsights(deps: InsightsDeps) {
  const { activeFolderId, generating, setInsights, setFolders, setGenerating } = deps;
  return async () => {
    if (!activeFolderId || generating) return;
    setGenerating(true);
    try {
      const apiInsight = await generateInsights(activeFolderId);
      if (apiInsight) {
        const transformed = transformInsights(apiInsight, activeFolderId);
        setInsights((prev) => ({ ...prev, [activeFolderId]: transformed }));
        // Reflect new readiness/red flags back on the folder card
        setFolders((prev) =>
          prev.map((f) => {
            if (f.id !== activeFolderId) return f;
            const pct = transformed.completionPercent;
            const hasFlags = transformed.redFlags.length > 0;
            if (pct >= 80 && !hasFlags) {
              return { ...f, status: "ready", statusColor: "green", statusLabel: `${pct}% Ready`, readinessPercent: pct };
            }
            if (hasFlags) {
              return { ...f, status: "attention", statusColor: "orange", statusLabel: "Attention", readinessPercent: pct };
            }
            return { ...f, readinessPercent: pct };
          }),
        );
      }
    } catch (err) {
      console.warn("[vdr] generateInsights failed:", err);
    } finally {
      setGenerating(false);
    }
  };
}

// ─── Upload (stage 2: confirm) ─────────────────────────────────────────

interface UploadDeps {
  dealId: string;
  activeFolderId: string | null;
  pendingUploadFiles: File[] | null;
  autoUpdateDeal: boolean;
  setUploading: Dispatch<SetStateAction<boolean>>;
  setPendingUploadFiles: Dispatch<SetStateAction<File[] | null>>;
  setUploadError: Dispatch<SetStateAction<string | null>>;
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  showToast: ToastFn;
}

export function createConfirmUpload(deps: UploadDeps) {
  const {
    dealId, activeFolderId, pendingUploadFiles, autoUpdateDeal,
    setUploading, setPendingUploadFiles, setUploadError, setAllFiles, setFolders, showToast,
  } = deps;
  return async () => {
    if (!pendingUploadFiles || !activeFolderId) return;

    setUploading(true);
    setPendingUploadFiles(null);
    setUploadError(null);
    const failures: string[] = [];
    const uploaded: APIDocument[] = [];

    for (const file of pendingUploadFiles) {
      try {
        const doc = await uploadDocument(dealId, activeFolderId, file, { autoUpdateDeal });
        if (doc) uploaded.push(doc);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
    }

    if (uploaded.length > 0) {
      const newFiles = uploaded.map(transformDocument);
      setAllFiles((prev) => [...newFiles, ...prev]);
      setFolders((prev) =>
        prev.map((f) =>
          f.id === activeFolderId ? { ...f, fileCount: f.fileCount + uploaded.length } : f,
        ),
      );
      showToast(`${uploaded.length} file(s) uploaded successfully`, "success");
    }
    if (failures.length > 0) {
      setUploadError(failures.join("; "));
      setTimeout(() => setUploadError(null), 6000);
    }
    setUploading(false);
  };
}

export function createRequestDocument(deps: InsightsDeps) {
  const { dealId, activeFolderId, activeFolder, activeFolderInsights } = deps;
  return async (docId: string) => {
    const doc = activeFolderInsights?.missingDocuments.find((d) => d.id === docId);
    if (!doc) return;
    try {
      await requestDocument(dealId, doc.name, {
        folderId: activeFolderId || undefined,
        folderName: activeFolder?.name,
      });
    } catch (err) {
      console.warn("[vdr] requestDocument failed:", err);
    }
  };
}

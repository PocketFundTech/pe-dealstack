// Export + Share + Create handlers extracted from page.tsx so the page itself
// fits under the 500-line cap. Each function is a factory that closes over
// the dependencies it needs and returns the async handler. Behavior is
// unchanged.

import { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { Memo, MemoSection } from "./components";
import { exportMemoPDF, exportMemoMarkdown, exportMemoClipboard, shareMemoLink } from "./export";

interface ExportDeps {
  selectedMemo: Memo | null;
  sections: MemoSection[];
  editingContent: Record<string, string>;
  setExportMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSuccessToast: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function createExportPDF(deps: ExportDeps) {
  const { selectedMemo, sections, editingContent, setExportMenuOpen, setSuccessToast, setError } = deps;
  return async () => {
    if (!selectedMemo || sections.length === 0) return;
    setExportMenuOpen(false);
    try {
      await exportMemoPDF(selectedMemo, sections, editingContent);
      setSuccessToast("Memo exported as PDF.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF export failed");
    }
  };
}

export function createExportMarkdown(deps: ExportDeps) {
  const { selectedMemo, sections, editingContent, setExportMenuOpen, setSuccessToast, setError } = deps;
  return () => {
    if (!selectedMemo || sections.length === 0) return;
    setExportMenuOpen(false);
    try {
      exportMemoMarkdown(selectedMemo, sections, editingContent);
      setSuccessToast("Memo exported as Markdown.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Markdown export failed");
    }
  };
}

export function createExportClipboard(deps: ExportDeps) {
  const { selectedMemo, sections, editingContent, setExportMenuOpen, setSuccessToast, setError } = deps;
  return async () => {
    if (!selectedMemo || sections.length === 0) return;
    setExportMenuOpen(false);
    try {
      await exportMemoClipboard(sections, editingContent);
      setSuccessToast("Memo content copied to clipboard.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
    }
  };
}

export function createShare(deps: ExportDeps) {
  const { selectedMemo, setSuccessToast, setError } = deps;
  return async () => {
    if (!selectedMemo) return;
    try {
      await shareMemoLink(selectedMemo.id);
      setSuccessToast(`Share link for "${selectedMemo.projectName || selectedMemo.title}" copied.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Share failed");
    }
  };
}

interface CreateMemoDeps {
  createForm: { dealId: string; templateId: string; title: string };
  setMemos: Dispatch<SetStateAction<Memo[]>>;
  setShowCreate: Dispatch<SetStateAction<boolean>>;
  setCreateForm: Dispatch<SetStateAction<{ dealId: string; templateId: string; title: string }>>;
  setCreatingMemo: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  loadMemo: (id: string) => Promise<void>;
}

export function createMemoHandler(deps: CreateMemoDeps) {
  const { createForm, setMemos, setShowCreate, setCreateForm, setCreatingMemo, setError, loadMemo } = deps;
  return async () => {
    setCreatingMemo(true);
    try {
      // autoGenerate: false — server-side generation inside POST /memos blocks
      // the response for ~60-150s and risks blowing Vercel's 300s function
      // budget when combined with cold-start, embeddings, and document fetch.
      // We create the memo fast; the user's "Generate All" click runs
      // /generate-all with its own budget and its own loading overlay.
      const body: Record<string, unknown> = {
        title: createForm.title,
        status: "DRAFT",
        type: "IC_MEMO",
        autoGenerate: false,
      };
      if (createForm.dealId) body.dealId = createForm.dealId;
      if (createForm.templateId) body.templateId = createForm.templateId;
      const created = await api.post<Memo>("/memos", body);
      setMemos((prev) => [created, ...prev]);
      setShowCreate(false);
      setCreateForm({ dealId: "", templateId: "", title: "Investment Committee Memo" });
      await loadMemo(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create memo");
    } finally {
      setCreatingMemo(false);
    }
  };
}

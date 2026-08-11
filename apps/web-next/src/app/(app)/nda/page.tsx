"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/providers/ToastProvider";
import { CreateDocModal } from "./CreateDocModal";
import { DealPicker, type PickableDeal } from "./DealPicker";
import { FullEditPage } from "./FullEditPage";
import { Gallery } from "./Gallery";
import { GoogleDocImportView } from "./GoogleDocImportView";
import { ImportGoogleDocFlow } from "./ImportGoogleDocFlow";
import { TemplatePicker } from "./TemplatePicker";
import { TemplateUploadFlow } from "./TemplateUploadFlow";
import { UploadExistingFlow } from "./UploadExistingFlow";
import {
  isImportedGdoc,
  type LegalDocTemplate,
  type LegalDocument,
  type LegalDocumentWithDeal,
} from "./types";

// State machine:
//   - "gallery":         the firm-wide list (default)
//   - "picker":          deal picker modal (create-from-template flow)
//   - "templatePicker":  verified-template picker modal
//   - "uploadTemplate":  inline template upload + verifier (no settings detour)
//   - "create":          counterparty form (template + deal locked in)
//   - "uploadExisting":  3-step import flow for an NDA done outside this app
//   - "importGdoc":      2-step "bring your own Google Doc" import flow
//   - "edit":            full-screen editor for an existing (template/file) row
//   - "gdocView":        post-import view for an imported-gdoc row (preview +
//                        open-externally + send) — used instead of "edit"
//                        because imported docs have content: null
type View =
  | { mode: "gallery" }
  | { mode: "picker" }
  | { mode: "templatePicker"; dealId: string; dealLabel: string }
  | { mode: "uploadTemplate"; resumeTo?: { dealId: string; dealLabel: string } }
  | {
      mode: "create";
      dealId: string;
      dealLabel: string;
      template: LegalDocTemplate;
    }
  | { mode: "uploadExisting" }
  | { mode: "importGdoc" }
  | { mode: "edit"; doc: LegalDocumentWithDeal }
  | { mode: "gdocView"; doc: LegalDocumentWithDeal };

export default function NdaPage() {
  const { showToast } = useToast();
  const searchParams = useSearchParams();

  const [docs, setDocs] = useState<LegalDocumentWithDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "gallery" });
  const [deleteTarget, setDeleteTarget] =
    useState<LegalDocumentWithDeal | null>(null);

  // Whenever we transition into the template-picker step, ensure at least
  // one verified template exists. If none, drop the user into the inline
  // template-upload flow on this page (no Settings detour — bad UX).
  // resumeTo lets the upload flow remember where the user was headed so we
  // can hop straight back into templatePicker once they finish saving.
  async function ensureVerifiedTemplatesOrPromptUpload(
    resumeTo?: { dealId: string; dealLabel: string },
  ): Promise<boolean> {
    try {
      const templates = await api.get<LegalDocTemplate[]>(
        "/legal-document-templates",
      );
      const hasVerified = Array.isArray(templates)
        && templates.some((t) => t.verifiedAt !== null);
      if (!hasVerified) {
        showToast("Upload a template to get started.", "info", {
          title: "No NDA templates yet",
        });
        setView({ mode: "uploadTemplate", resumeTo });
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[nda] template gate failed:", err);
      // Don't block on a transient error — let the picker render its own
      // error state so the user can see what happened.
      return true;
    }
  }

  // Deep-link handoff from the deal page's "New NDA" button:
  //   /nda?dealId=...&dealLabel=...&create=1
  // Skip the deal picker (deal context is already known on the source page)
  // and drop straight into the template-picker step. Ref-guarded so React
  // strict-mode's double-mount doesn't fire this twice.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const dealId = searchParams.get("dealId");
    const create = searchParams.get("create");
    if (!dealId || !create) {
      deepLinkHandled.current = true;
      return;
    }
    const dealLabel = searchParams.get("dealLabel") || "Untitled deal";
    deepLinkHandled.current = true;
    (async () => {
      // Pass resumeTo so if templates are missing, the upload flow knows
      // to drop the user straight into the template-picker for THIS deal
      // after they save — instead of dumping them back on the gallery.
      const ok = await ensureVerifiedTemplatesOrPromptUpload({
        dealId,
        dealLabel,
      });
      if (ok) setView({ mode: "templatePicker", dealId, dealLabel });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // In-flight guard for refetches. A plain ref (not a `loading` state dep) so
  // loadDocs can stay deps-free — it never closes over this, the focus/visibility
  // effect reads it directly.
  const fetchingRef = useRef(false);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<LegalDocumentWithDeal[]>(
        "/legal-documents?docType=NDA",
      );
      setDocs(Array.isArray(data) ? data : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load NDAs";
      console.warn("[nda] load failed:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Ask the backend to poll Drive for counterparty signatures (the active
  // detection path while push webhooks are disabled on Vercel). Best-effort —
  // if it fails we still refresh the list below.
  const checkSignatures = useCallback(async () => {
    try {
      await api.post("/legal-documents/check-signatures", {});
    } catch (err) {
      console.warn("[nda] signature check failed:", err);
    }
  }, []);

  // Refetch wrapper that drops overlapping calls. Used by the focus/visibility
  // listeners so the in-flight guard is honored without touching loadDocs.
  const refetch = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      await checkSignatures();
      await loadDocs();
    } finally {
      fetchingRef.current = false;
    }
  }, [checkSignatures, loadDocs]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Poll once on mount so a signature completed while away surfaces without
  // needing a tab blur/focus. Best-effort; refreshes the list when done.
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detected signatures get flipped to SIGNED server-side (the active path
  // is on-demand Drive polling; the Drive watch webhook is dormant outside
  // prod). Refetch when the tab regains focus / becomes visible so those
  // server-side changes surface without a manual reload.
  useEffect(() => {
    function handleFocus() {
      refetch();
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") refetch();
    }
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refetch]);

  /* -------------------- Gallery callbacks -------------------- */

  async function handleCreate() {
    const ok = await ensureVerifiedTemplatesOrPromptUpload();
    if (ok) setView({ mode: "picker" });
  }

  function handleUploadExisting() {
    // Imports skip the template gate — the file IS the source of truth.
    setView({ mode: "uploadExisting" });
  }

  function handleImportGdoc() {
    // Bring-your-own-Google-Doc also skips the template gate — the linked Doc
    // is the source of truth.
    setView({ mode: "importGdoc" });
  }

  function handleEdit(doc: LegalDocumentWithDeal) {
    // Imported Google Docs have content: null and live entirely in Drive, so
    // the HTML editor doesn't apply — route them to the preview/send view.
    if (isImportedGdoc(doc)) {
      setView({ mode: "gdocView", doc });
      return;
    }
    setView({ mode: "edit", doc });
  }

  function handleDeleteRequest(doc: LegalDocumentWithDeal) {
    setDeleteTarget(doc);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    // Optimistic remove — refetch on failure to reconcile. Backend soft-deletes
    // so the row still exists, just hidden from GET responses.
    setDocs((ds) => ds.filter((d) => d.id !== target.id));
    setDeleteTarget(null);
    try {
      await api.delete(`/legal-documents/${target.id}`);
      showToast(`Deleted "${target.title}"`, "success");
    } catch (err) {
      console.warn("[nda] delete failed:", err);
      const message =
        err instanceof Error ? err.message : "Failed to delete NDA";
      showToast(message, "error", { title: "Delete failed" });
      loadDocs();
    }
  }

  /* -------------------- Picker / Template / Create callbacks -------------------- */

  function handlePickerSelect(deal: PickableDeal) {
    setView({ mode: "templatePicker", dealId: deal.id, dealLabel: deal.label });
  }

  function handleTemplateSelect(template: LegalDocTemplate) {
    if (view.mode !== "templatePicker") return;
    setView({
      mode: "create",
      dealId: view.dealId,
      dealLabel: view.dealLabel,
      template,
    });
  }

  function handleCreated(doc: LegalDocument) {
    // Synthesize a `deal` summary so we can transition straight into the
    // editor without a second round-trip. The trailing refetch swaps in the
    // canonical row (which carries the real projectName/target).
    const dealCtx =
      view.mode === "create"
        ? {
            id: view.dealId,
            target: view.dealLabel.split(" · ")[0] || null,
            projectName: null,
          }
        : { id: doc.dealId, target: null, projectName: null };
    const withDeal: LegalDocumentWithDeal = {
      ...doc,
      deal: { ...dealCtx, id: doc.dealId },
    };
    setDocs((ds) => [withDeal, ...ds]);
    showToast(`Created "${doc.title}"`, "success");
    setView({ mode: "edit", doc: withDeal });
    loadDocs();
  }

  function handleImported(doc: LegalDocument) {
    // Same shape as handleCreated but with an "Imported" toast instead of
    // "Created" so the user knows the row came from upload-existing, not
    // template-substitution. We don't have the deal label on hand here
    // (the flow owns it internally), so fall back to null; loadDocs will
    // refresh with the canonical deal join shortly.
    const withDeal: LegalDocumentWithDeal = {
      ...doc,
      deal: { id: doc.dealId, target: null, projectName: null },
    };
    setDocs((ds) => [withDeal, ...ds]);
    showToast(`Imported "${doc.title}"`, "success");
    setView({ mode: "edit", doc: withDeal });
    loadDocs();
  }

  function handleGdocImported(doc: LegalDocument) {
    // Mirrors handleImported but routes into the gdocView (preview + send)
    // instead of the HTML editor — imported Google Docs have content: null.
    // Deal label isn't on hand here (the flow owns it); loadDocs refreshes
    // with the canonical deal join shortly after.
    const withDeal: LegalDocumentWithDeal = {
      ...doc,
      deal: { id: doc.dealId, target: null, projectName: null },
    };
    setDocs((ds) => [withDeal, ...ds]);
    showToast(`Imported "${doc.title}"`, "success");
    setView({ mode: "gdocView", doc: withDeal });
    loadDocs();
  }

  function handleGdocSent(updated: LegalDocumentWithDeal) {
    // Echo the post-send row into the list + keep the gdocView open with the
    // freshest data (status now SENT). Preserve the existing deal join.
    setDocs((ds) =>
      ds.map((d) =>
        d.id === updated.id ? { ...d, ...updated, deal: d.deal } : d,
      ),
    );
    setView((v) => {
      if (v.mode !== "gdocView") return v;
      return {
        mode: "gdocView",
        doc: { ...v.doc, ...updated, deal: v.doc.deal },
      };
    });
    // Refresh so the canonical row (sentAt, googleDoc*) replaces our optimistic
    // copy; the signature poll also runs via the existing focus/visibility path.
    loadDocs();
  }

  function handleSaved(updated: LegalDocument) {
    setDocs((ds) =>
      ds.map((d) => (d.id === updated.id ? { ...d, ...updated, deal: d.deal } : d)),
    );
    // Keep the editor open with the freshest data so the user can keep
    // working. The toast that signals success fires inside FullEditPage.
    setView((v) => {
      if (v.mode !== "edit") return v;
      return { mode: "edit", doc: { ...v.doc, ...updated, deal: v.doc.deal } };
    });
  }

  /* -------------------- Render -------------------- */

  // The full-screen editor takes over the page when active. Otherwise the
  // gallery is rendered underneath any modal so the page never goes blank.
  if (view.mode === "edit") {
    return (
      <FullEditPage
        doc={view.doc}
        onBack={() => setView({ mode: "gallery" })}
        onSaved={handleSaved}
      />
    );
  }

  // Imported Google Docs get their own full-screen view (embedded preview +
  // open-externally + send) instead of the HTML editor.
  if (view.mode === "gdocView") {
    return (
      <GoogleDocImportView
        doc={view.doc}
        onBack={() => setView({ mode: "gallery" })}
        onSent={handleGdocSent}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 text-slate-900">
      <Gallery
        docs={docs}
        loading={loading}
        error={error}
        onCreate={handleCreate}
        onUploadExisting={handleUploadExisting}
        onImportGdoc={handleImportGdoc}
        onEdit={handleEdit}
        onDelete={handleDeleteRequest}
        onDismissError={() => setError(null)}
      />

      <DealPicker
        open={view.mode === "picker"}
        onCancel={() => setView({ mode: "gallery" })}
        onSelect={handlePickerSelect}
      />

      <TemplatePicker
        open={view.mode === "templatePicker"}
        dealLabel={view.mode === "templatePicker" ? view.dealLabel : ""}
        onCancel={() => setView({ mode: "gallery" })}
        onSelect={handleTemplateSelect}
      />

      {view.mode === "uploadTemplate" && (
        <TemplateUploadFlow
          onCancel={() => setView({ mode: "gallery" })}
          onSaved={() => {
            // If the user was mid-flow (clicked "New NDA" → got gated →
            // uploaded a template), hop straight into the template picker
            // for the deal they were headed to. Otherwise just land back
            // on the gallery so they can see the new template took.
            const resumeTo =
              view.mode === "uploadTemplate" ? view.resumeTo : undefined;
            if (resumeTo) {
              setView({
                mode: "templatePicker",
                dealId: resumeTo.dealId,
                dealLabel: resumeTo.dealLabel,
              });
            } else {
              setView({ mode: "gallery" });
            }
          }}
        />
      )}

      {view.mode === "uploadExisting" && (
        <UploadExistingFlow
          onCancel={() => setView({ mode: "gallery" })}
          onCreated={handleImported}
        />
      )}

      {view.mode === "importGdoc" && (
        <ImportGoogleDocFlow
          onCancel={() => setView({ mode: "gallery" })}
          onImported={handleGdocImported}
        />
      )}

      <CreateDocModal
        open={view.mode === "create"}
        dealId={view.mode === "create" ? view.dealId : ""}
        dealLabel={view.mode === "create" ? view.dealLabel : ""}
        template={view.mode === "create" ? view.template : null}
        onCancel={() => setView({ mode: "gallery" })}
        onCreated={handleCreated}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete NDA?"
        message={
          deleteTarget
            ? `"${deleteTarget.title}" will be removed from your library. This is a soft delete — admins can recover it for 30 days.`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

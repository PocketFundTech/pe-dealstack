"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/providers/ToastProvider";
import { TemplateUploadFlow } from "@/app/(app)/nda/TemplateUploadFlow";
import { TemplateVerifier } from "@/app/(app)/nda/TemplateVerifier";
import type {
  LegalDocTemplate,
  UpdateTemplateBody,
} from "@/app/(app)/nda/types";

type Modal =
  | { kind: "none" }
  | { kind: "upload" }
  | { kind: "edit"; template: LegalDocTemplate };

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Settings panel that manages an org's NDA templates. Lists every template
 * (verified and draft), lets admins upload new ones via TemplateUploadFlow,
 * re-edit them via TemplateVerifier, mark one as default, or delete.
 *
 * Mounted in /settings under the `#nda-templates` anchor so the toast
 * redirect from /nda/page.tsx ("Upload a template first") lands here.
 */
export function NDATemplatesSection() {
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<LegalDocTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<Modal>({ kind: "none" });
  const [deleteTarget, setDeleteTarget] = useState<LegalDocTemplate | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<LegalDocTemplate[]>(
        "/legal-document-templates",
      );
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[settings/nda-templates] load failed:", err);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSetDefault(template: LegalDocTemplate) {
    if (template.isDefault) return;
    setBusyId(template.id);
    try {
      const body: UpdateTemplateBody = { isDefault: true };
      const updated = await api.patch<LegalDocTemplate>(
        `/legal-document-templates/${template.id}`,
        body,
      );
      // Optimistic: flip default locally for every row so the badge moves
      // even if the server hasn't echoed the others yet.
      setTemplates((all) =>
        all.map((t) =>
          t.id === updated.id
            ? { ...t, ...updated }
            : { ...t, isDefault: false },
        ),
      );
      showToast(`"${updated.name}" is now the default`, "success");
    } catch (err) {
      console.warn("[settings/nda-templates] set default failed:", err);
      showToast(
        err instanceof Error ? err.message : "Failed to set default",
        "error",
      );
      load();
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(template: LegalDocTemplate) {
    setDeleteTarget(null);
    setBusyId(template.id);
    // Optimistic — restore on failure.
    setTemplates((all) => all.filter((t) => t.id !== template.id));
    try {
      await api.delete(`/legal-document-templates/${template.id}`);
      showToast(`Deleted "${template.name}"`, "success");
    } catch (err) {
      console.warn("[settings/nda-templates] delete failed:", err);
      showToast(
        err instanceof Error ? err.message : "Delete failed",
        "error",
      );
      load();
    } finally {
      setBusyId(null);
    }
  }

  function handleSaved(saved: LegalDocTemplate) {
    setTemplates((all) => {
      const exists = all.some((t) => t.id === saved.id);
      if (!exists) return [saved, ...all];
      return all.map((t) => (t.id === saved.id ? saved : t));
    });
    setModal({ kind: "none" });
    load();
  }

  return (
    <section
      id="nda-templates"
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
    >
      <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-light rounded-lg text-primary border border-primary/20">
            <span className="material-symbols-outlined text-[20px] block">
              gavel
            </span>
          </div>
          <div>
            <h2 className="text-base font-bold text-text-main">NDA Templates</h2>
            <p className="text-xs text-text-muted">
              Upload Word, HTML, or markdown templates and mark them with
              placeholder tokens. Verified templates appear in the NDA create
              flow.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setModal({ kind: "upload" })}
          className="px-3 py-1.5 rounded-md text-xs font-semibold text-white inline-flex items-center gap-1.5 hover:opacity-90"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[14px]">upload</span>
          Upload new template
        </button>
      </div>

      <div className="p-6">
        {loading ? (
          <p className="text-sm text-text-muted">Loading templates…</p>
        ) : templates.length === 0 ? (
          <div className="text-center py-10 px-6 border-2 border-dashed border-slate-200 rounded-lg bg-slate-50/40">
            <div className="w-12 h-12 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-400 mb-3 mx-auto">
              <span className="material-symbols-outlined text-[24px]">article</span>
            </div>
            <div className="text-sm font-medium text-slate-700 mb-1">
              No templates yet
            </div>
            <div className="text-[12px] text-slate-500 max-w-md mx-auto">
              Upload a .docx, .html, or .md template to get started. You can
              mark up placeholder tokens once it&rsquo;s parsed.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                busy={busyId === t.id}
                onEdit={() => setModal({ kind: "edit", template: t })}
                onSetDefault={() => handleSetDefault(t)}
                onDelete={() => setDeleteTarget(t)}
              />
            ))}
          </ul>
        )}
      </div>

      {modal.kind === "upload" && (
        <TemplateUploadFlow
          onCancel={() => setModal({ kind: "none" })}
          onSaved={handleSaved}
        />
      )}
      {modal.kind === "edit" && (
        <TemplateVerifier
          mode="edit"
          template={modal.template}
          onCancel={() => setModal({ kind: "none" })}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete template?"
        message={
          deleteTarget
            ? `"${deleteTarget.name}" will be removed. NDAs already created from it stay untouched.`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

interface TemplateRowProps {
  template: LegalDocTemplate;
  busy: boolean;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

function TemplateRow({
  template,
  busy,
  onEdit,
  onSetDefault,
  onDelete,
}: TemplateRowProps) {
  const isVerified = template.verifiedAt !== null;
  return (
    <li className="py-3 flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: "#E6EEF5", color: "#003366" }}
      >
        <span className="material-symbols-outlined text-[20px]">article</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-slate-900 truncate">
            {template.name}
          </div>
          {template.isDefault && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#003366] text-white shrink-0">
              Default
            </span>
          )}
          <span
            className={cn(
              "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0",
              isVerified
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200",
            )}
          >
            {isVerified ? "Verified" : "Draft"}
          </span>
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
          Created {formatTs(template.createdAt)}
          {template.originalFileName && (
            <>
              {" · "}
              <span className="font-mono">{template.originalFileName}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="px-2.5 py-1 rounded-md text-xs font-medium border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Edit
        </button>
        {!template.isDefault && (
          <button
            type="button"
            onClick={onSetDefault}
            disabled={busy || !isVerified}
            title={!isVerified ? "Verify the template before making it default" : undefined}
            className="px-2.5 py-1 rounded-md text-xs font-medium border border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Set as default
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="px-2.5 py-1 rounded-md text-xs font-medium border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

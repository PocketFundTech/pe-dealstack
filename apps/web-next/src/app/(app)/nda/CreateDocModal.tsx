"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { CreateDocBody, LegalDocTemplate, LegalDocument } from "./types";

interface CreateDocModalProps {
  open: boolean;
  dealId: string;
  dealLabel: string;
  template: LegalDocTemplate | null;
  onCancel: () => void;
  onCreated: (doc: LegalDocument) => void;
}

type Banner =
  | { kind: "none" }
  | { kind: "templateMissing" }
  | { kind: "templateNotVerified" }
  | { kind: "generic"; message: string };

function defaultTitle(counterpartyName: string): string {
  const cp = counterpartyName.trim();
  return cp ? `NDA — ${cp}` : "NDA";
}

/**
 * Step 3 of the create flow — counterparty form. The template is locked in
 * by the time we get here; there's no "blank document" branch anymore (every
 * NDA must come from a verified template). On submit we POST and hand the
 * resulting row back so the parent can drop straight into the full editor.
 */
export function CreateDocModal({
  open,
  dealId,
  dealLabel,
  template,
  onCancel,
  onCreated,
}: CreateDocModalProps) {
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyEmail, setCounterpartyEmail] = useState("");
  const [counterpartyAddress, setCounterpartyAddress] = useState("");
  // titleDirty tracks whether the user has hand-edited the title; until then
  // we keep it in lockstep with the auto-pattern "NDA — {counterparty}" so the
  // friendly default updates as they type the counterparty name.
  const [title, setTitle] = useState("NDA");
  const [titleDirty, setTitleDirty] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<Banner>({ kind: "none" });

  useEffect(() => {
    if (!open) return;
    setCounterpartyName("");
    setCounterpartyEmail("");
    setCounterpartyAddress("");
    setTitle(defaultTitle(""));
    setTitleDirty(false);
    setEffectiveDate("");
    setJurisdiction("");
    setBanner({ kind: "none" });
    setSubmitting(false);
  }, [open]);

  // Keep the auto-title in sync until the user takes the wheel.
  useEffect(() => {
    if (titleDirty) return;
    setTitle(defaultTitle(counterpartyName));
  }, [counterpartyName, titleDirty]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, submitting]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!template) {
      setBanner({ kind: "templateMissing" });
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setBanner({ kind: "generic", message: "Title is required." });
      return;
    }

    const body: CreateDocBody = {
      templateId: template.id,
      title: trimmedTitle,
      counterpartyName: counterpartyName.trim() || undefined,
      counterpartyEmail: counterpartyEmail.trim() || undefined,
      counterpartyAddress: counterpartyAddress.trim() || undefined,
      effectiveDate: effectiveDate || undefined,
      jurisdiction: jurisdiction.trim() || undefined,
    };

    setSubmitting(true);
    setBanner({ kind: "none" });
    try {
      const doc = await api.post<LegalDocument>(
        `/deals/${dealId}/legal-documents`,
        body,
      );
      onCreated(doc);
    } catch (err) {
      console.warn("[nda] create failed:", err);
      setBanner(bannerForError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && !submitting && onCancel()}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">New NDA</h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              For{" "}
              <span className="text-[#003366] font-medium">{dealLabel}</span>{" "}
              · Template: <span className="font-medium">{template?.name ?? "—"}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {banner.kind !== "none" && <ErrorBanner banner={banner} />}

          <Field label="Title" required>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleDirty(true);
              }}
              required
              placeholder="NDA — Acme Corp"
              className={inputCls}
            />
          </Field>

          <Field label="Counterparty name">
            <input
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder="Acme Corp"
              className={inputCls}
            />
          </Field>

          <Field label="Counterparty email">
            <input
              type="email"
              value={counterpartyEmail}
              onChange={(e) => setCounterpartyEmail(e.target.value)}
              placeholder="legal@acme.com"
              className={inputCls}
            />
          </Field>

          <Field label="Counterparty address">
            <textarea
              value={counterpartyAddress}
              onChange={(e) => setCounterpartyAddress(e.target.value)}
              rows={3}
              placeholder="100 Main St, Suite 500, Wilmington, DE 19801"
              className={cn(inputCls, "resize-y")}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective date">
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Jurisdiction">
              <input
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                placeholder="State of Delaware"
                className={inputCls}
              />
            </Field>
          </div>

          <p className="text-[11px] text-slate-500">
            Placeholder tokens in the template (e.g.{" "}
            <span className="font-mono">[COUNTERPARTY_NAME]</span>) get
            substituted as soon as the NDA is created. You can tweak the
            wording in the editor before sending.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "px-4 py-2 rounded-md text-sm font-semibold text-white inline-flex items-center gap-1.5",
              submitting ? "opacity-70 cursor-not-allowed" : "hover:opacity-90",
            )}
            style={{ backgroundColor: "#003366" }}
          >
            {submitting && (
              <span className="material-symbols-outlined text-[16px] animate-spin">
                progress_activity
              </span>
            )}
            {submitting ? "Creating…" : "Create NDA"}
          </button>
        </div>
      </form>
    </div>
  );
}

// --------------------------- error mapping --------------------------- //

function bannerForError(err: unknown): Banner {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "TEMPLATE_NOT_FOUND":
        return { kind: "templateMissing" };
      case "TEMPLATE_NOT_VERIFIED":
        return { kind: "templateNotVerified" };
      default:
        return { kind: "generic", message: err.message };
    }
  }
  return {
    kind: "generic",
    message: err instanceof Error ? err.message : "Failed to create NDA",
  };
}

// --------------------------- small UI bits --------------------------- //

const inputCls =
  "w-full px-3 py-2 text-sm rounded-md border border-slate-200 focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15 outline-none";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-700 mb-1.5">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </div>
      {children}
    </label>
  );
}

function ErrorBanner({ banner }: { banner: Banner }) {
  if (banner.kind === "none") return null;
  const message =
    banner.kind === "templateMissing"
      ? "Template no longer exists; pick another."
      : banner.kind === "templateNotVerified"
        ? "Template hasn't been verified yet."
        : banner.kind === "generic"
          ? banner.message
          : "";
  return (
    <div className="rounded-lg px-3 py-3 text-sm border flex items-start gap-2 bg-red-50 border-red-200 text-red-700">
      <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">error</span>
      <div className="flex-1 min-w-0 leading-snug">{message}</div>
    </div>
  );
}

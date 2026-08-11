"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { STATUS_LABELS } from "./constants";
import type { UploadExistingMetadata } from "./types";

// Status options for the upload flow. DRAFT is intentionally excluded —
// the create-from-template pipeline owns DRAFT (so the placeholder
// substitution can't be skipped). Backend enforces the same constraint.
const UPLOAD_STATUS_OPTIONS: Array<"SENT" | "SIGNED"> = ["SENT", "SIGNED"];

export interface UploadExistingMetadataFormProps {
  dealLabel: string;
  /** Used to seed the default title (filename minus extension). */
  suggestedTitle: string;
  /** Optional filename to display under the title field as provenance. */
  originalFileName?: string | null;
  /** Disable inputs + buttons while the submit is in flight. */
  submitting: boolean;
  /** Top-level banner message — set by the parent on submit failure. */
  error: string | null;
  onBack: () => void;
  onCancel: () => void;
  onSubmit: (meta: UploadExistingMetadata) => void;
}

interface FormState {
  title: string;
  status: "SENT" | "SIGNED";
  counterpartyName: string;
  counterpartyEmail: string;
  counterpartyAddress: string;
  jurisdiction: string;
  effectiveDate: string;
  expiresAt: string;
  sentAt: string;   // datetime-local
  signedAt: string; // datetime-local
  sentToEmail: string;
}

function initial(title: string): FormState {
  return {
    title,
    status: "SENT",
    counterpartyName: "",
    counterpartyEmail: "",
    counterpartyAddress: "",
    jurisdiction: "",
    effectiveDate: "",
    expiresAt: "",
    sentAt: "",
    signedAt: "",
    sentToEmail: "",
  };
}

/**
 * Metadata form rendered as step 2 of the UploadExistingFlow modal. The
 * status picker conditionally hides irrelevant date fields:
 *   - SENT: shows sentAt + sentToEmail
 *   - SIGNED: shows signedAt (and the doc was presumably also sent — we
 *     keep sentAt available there too for completeness)
 *
 * The parent owns the multipart POST so this form is purely UI — onSubmit
 * receives the trimmed/coerced metadata, the parent appends the file +
 * kind and dispatches the request.
 */
export function UploadExistingMetadataForm({
  dealLabel,
  suggestedTitle,
  originalFileName,
  submitting,
  error,
  onBack,
  onCancel,
  onSubmit,
}: UploadExistingMetadataFormProps) {
  const [form, setForm] = useState<FormState>(() => initial(suggestedTitle));
  const [localError, setLocalError] = useState<string | null>(null);

  // Seed once on mount with the parent's suggested title. We deliberately
  // don't re-sync if the prop changes mid-flight (the user may have hand-
  // edited it) — the upstream flow only mounts this once per upload.
  useEffect(() => {
    setForm((f) => ({ ...f, title: f.title || suggestedTitle }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setLocalError(null);
    const trimmedTitle = form.title.trim();
    if (!trimmedTitle) {
      setLocalError("Title is required.");
      return;
    }

    // Convert datetime-local back to ISO so the backend's z.string().datetime()
    // schema accepts it. The browser's datetime-local omits the timezone, so
    // we let Date interpret it as wall-clock local time then serialize to UTC.
    function localToIso(local: string): string | undefined {
      if (!local) return undefined;
      const d = new Date(local);
      if (Number.isNaN(d.getTime())) return undefined;
      return d.toISOString();
    }

    const meta: UploadExistingMetadata = {
      title: trimmedTitle,
      status: form.status,
      counterpartyName: form.counterpartyName.trim() || undefined,
      counterpartyEmail: form.counterpartyEmail.trim() || undefined,
      counterpartyAddress: form.counterpartyAddress.trim() || undefined,
      jurisdiction: form.jurisdiction.trim() || undefined,
      effectiveDate: form.effectiveDate || undefined,
      expiresAt: form.expiresAt || undefined,
      sentAt: localToIso(form.sentAt),
      signedAt: localToIso(form.signedAt),
      sentToEmail: form.sentToEmail.trim() || undefined,
    };
    onSubmit(meta);
  }

  const isSent = form.status === "SENT";
  const isSigned = form.status === "SIGNED";
  const bannerError = error ?? localError;

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between shrink-0">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-slate-900">Import existing NDA</h2>
          <p className="text-xs text-slate-500 mt-0.5 truncate">
            For{" "}
            <span className="text-[#003366] font-medium">{dealLabel}</span>
            {originalFileName && (
              <>
                {" · "}from{" "}
                <span className="font-medium">{originalFileName}</span>
              </>
            )}
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
        {bannerError && (
          <div className="rounded-lg px-3 py-3 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">error</span>
            <div className="flex-1 min-w-0 leading-snug">{bannerError}</div>
          </div>
        )}

        <Field label="Title" required>
          <input
            value={form.title}
            onChange={(e) => patch("title", e.target.value)}
            required
            placeholder="NDA — Acme Corp"
            className={inputCls}
          />
        </Field>

        <Field label="Status" required>
          <select
            value={form.status}
            onChange={(e) => patch("status", e.target.value as "SENT" | "SIGNED")}
            className={inputCls}
          >
            {UPLOAD_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">
            Imported NDAs skip the send pipeline — pick Sent or Signed based
            on where it landed.
          </p>
        </Field>

        <Field label="Counterparty name">
          <input
            value={form.counterpartyName}
            onChange={(e) => patch("counterpartyName", e.target.value)}
            placeholder="Acme Corp"
            className={inputCls}
          />
        </Field>

        <Field label="Counterparty email">
          <input
            type="email"
            value={form.counterpartyEmail}
            onChange={(e) => patch("counterpartyEmail", e.target.value)}
            placeholder="legal@acme.com"
            className={inputCls}
          />
        </Field>

        <Field label="Counterparty address">
          <textarea
            value={form.counterpartyAddress}
            onChange={(e) => patch("counterpartyAddress", e.target.value)}
            rows={2}
            placeholder="100 Main St, Suite 500, Wilmington, DE 19801"
            className={cn(inputCls, "resize-y")}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective date">
            <input
              type="date"
              value={form.effectiveDate}
              onChange={(e) => patch("effectiveDate", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Jurisdiction">
            <input
              value={form.jurisdiction}
              onChange={(e) => patch("jurisdiction", e.target.value)}
              placeholder="State of Delaware"
              className={inputCls}
            />
          </Field>
        </div>

        {/* Status-conditional fields. Sent → ask for when + recipient.
            Signed → ask for when. We keep sentAt visible on Signed too
            (a signed doc was almost certainly sent first) but don't make
            it required — the user may not know. */}
        {isSent && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sent at">
              <input
                type="datetime-local"
                value={form.sentAt}
                onChange={(e) => patch("sentAt", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Sent to email">
              <input
                type="email"
                value={form.sentToEmail}
                onChange={(e) => patch("sentToEmail", e.target.value)}
                placeholder="legal@acme.com"
                className={inputCls}
              />
            </Field>
          </div>
        )}

        {isSigned && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Signed at">
              <input
                type="datetime-local"
                value={form.signedAt}
                onChange={(e) => patch("signedAt", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Sent at">
              <input
                type="datetime-local"
                value={form.sentAt}
                onChange={(e) => patch("sentAt", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        )}

        <Field label="Expires at">
          <input
            type="date"
            value={form.expiresAt}
            onChange={(e) => patch("expiresAt", e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-2 shrink-0">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Back
        </button>
        <div className="flex items-center gap-2">
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
            {submitting ? "Importing…" : "Import NDA"}
          </button>
        </div>
      </div>
    </form>
  );
}

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

// Re-exported for completeness in case a parent wants to import the same
// constant later (e.g. seeing what status options the form accepts).
export { UPLOAD_STATUS_OPTIONS };

"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type {
  LegalDocumentWithDeal,
  SendForSignatureResponse,
} from "./types";

interface SendForSignatureModalProps {
  open: boolean;
  doc: LegalDocumentWithDeal | null;
  onCancel: () => void;
  onSent: (resp: SendForSignatureResponse, toEmail: string) => void;
}

// Banner states for the eSignature send modal. Maps the backend's
// LegalDocEsignError codes onto actionable copy.
type Banner =
  | { kind: "none" }
  | { kind: "notConfigured" }
  | { kind: "noRecipient" }
  | { kind: "exportFailed"; details: string }
  | { kind: "providerError"; details: string }
  | { kind: "generic"; message: string };

function defaultSubject(doc: LegalDocumentWithDeal | null): string {
  if (!doc) return "";
  const dealName = doc.deal.target || doc.deal.projectName || doc.title;
  return `${dealName} — signature request`;
}

/**
 * Sends the document for e-signature via Dropbox Sign: the server renders the
 * NDA to a locked PDF (same Google Drive export the download button uses) and
 * dispatches a signature request. The counterparty receives a non-editable
 * document to sign — replacing the "share an editable Google Doc link" flow.
 * On completion a flattened, signed PDF + audit trail comes back via webhook.
 */
export function SendForSignatureModal({
  open,
  doc,
  onCancel,
  onSent,
}: SendForSignatureModalProps) {
  const [toEmail, setToEmail] = useState("");
  const [signerName, setSignerName] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<Banner>({ kind: "none" });

  useEffect(() => {
    if (!open) return;
    setToEmail(doc?.counterpartyEmail ?? "");
    setSignerName(doc?.counterpartyName ?? "");
    setSubject(defaultSubject(doc));
    setMessage("");
    setBanner({ kind: "none" });
    setSubmitting(false);
  }, [open, doc]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, submitting]);

  if (!open || !doc) return null;

  async function handleSend() {
    if (!doc || submitting) return;
    const trimmed = toEmail.trim();
    if (!trimmed) {
      setBanner({ kind: "noRecipient" });
      return;
    }
    setSubmitting(true);
    setBanner({ kind: "none" });
    try {
      const resp = await api.post<SendForSignatureResponse>(
        `/legal-documents/${doc.id}/send-for-signature`,
        {
          toEmail: trimmed,
          signerName: signerName.trim() || undefined,
          subject: subject.trim() || undefined,
          message: message.trim() || undefined,
        },
      );
      onSent(resp, trimmed);
    } catch (err) {
      console.warn("[nda] send-for-signature failed:", err);
      setBanner(bannerForError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const isFailed =
    banner.kind === "exportFailed" || banner.kind === "providerError";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && !submitting && onCancel()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">
              Send for signature
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Sends a locked PDF via Dropbox Sign. The counterparty signs a
              non-editable document and you get a signed PDF back.
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

          <Field label="Signer email" required>
            <input
              type="email"
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="legal@acme.com"
              required
              className={inputCls}
            />
          </Field>

          <Field label="Signer name">
            <input
              value={signerName}
              onChange={(e) => setSignerName(e.target.value)}
              placeholder="Jane Counsel"
              className={inputCls}
            />
          </Field>

          <Field label="Subject">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Message">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Optional note shown to the signer in the Dropbox Sign request."
              className={cn(inputCls, "resize-y")}
            />
          </Field>
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
            {isFailed
              ? "Retry"
              : submitting
                ? "Sending…"
                : "Send for signature"}
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
      case "NOT_CONFIGURED":
        return { kind: "notConfigured" };
      case "NO_RECIPIENT":
        return { kind: "noRecipient" };
      case "EXPORT_FAILED":
        return { kind: "exportFailed", details: err.message };
      case "PROVIDER_ERROR":
        return { kind: "providerError", details: err.message };
      default:
        return { kind: "generic", message: err.message };
    }
  }
  return {
    kind: "generic",
    message: err instanceof Error ? err.message : "Failed to send",
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

  // Yellow = fixable config (provider not set up, no recipient). Red = a
  // hard failure during PDF export or at the provider.
  const isInfo = banner.kind === "notConfigured" || banner.kind === "noRecipient";

  const message = (() => {
    switch (banner.kind) {
      case "notConfigured":
        return "E-signature isn't configured yet. Add DROPBOX_SIGN_API_KEY to the API environment to enable this.";
      case "noRecipient":
        return "Fill in the signer email first.";
      case "exportFailed":
        return `Couldn't render the document to PDF: ${banner.details}`;
      case "providerError":
        return `Dropbox Sign error: ${banner.details}`;
      case "generic":
        return banner.message;
      default:
        return "";
    }
  })();

  return (
    <div
      className={cn(
        "rounded-lg px-3 py-3 text-sm border flex items-start gap-2",
        isInfo
          ? "bg-amber-50 border-amber-200 text-amber-800"
          : "bg-red-50 border-red-200 text-red-700",
      )}
    >
      <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">
        {isInfo ? "info" : "error"}
      </span>
      <div className="flex-1 min-w-0 leading-snug">{message}</div>
    </div>
  );
}

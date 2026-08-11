"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { STATUS_COLOR_CLASSES, STATUS_LABELS } from "./constants";
import { SendModal } from "./SendModal";
import type {
  LegalDocumentWithDeal,
  SendDocResponse,
} from "./types";

interface GoogleDocImportViewProps {
  doc: LegalDocumentWithDeal;
  onBack: () => void;
  // Bubbles the post-send doc back up so the page can refresh the row (status
  // flips to SENT, googleDoc* populate). Mirrors FullEditPage.onSaved's role.
  onSent: (updated: LegalDocumentWithDeal) => void;
}

/**
 * Post-import screen for a "bring your own Google Doc" NDA. Imported docs have
 * `content: null` — they live entirely in Google Docs — so the HTML editor
 * (FullEditPage) doesn't apply. Instead we show:
 *   - an embedded read-only preview of the Doc (Google's /preview iframe),
 *   - an "Open in Google Docs" link to edit / add a native eSignature field,
 *   - a hint explaining the Tools → eSignature path,
 *   - a Send action that reuses the existing SendModal (which for imported
 *     docs just shares + emails the existing Doc — no copy is made).
 *
 * If the doc is already SENT/SIGNED we surface that state (and the same
 * auto-detected-signature badge Gallery uses) instead of the "draft → send"
 * call-to-action.
 */
export function GoogleDocImportView({
  doc,
  onBack,
  onSent,
}: GoogleDocImportViewProps) {
  const [sendOpen, setSendOpen] = useState(false);

  const statusCls = STATUS_COLOR_CLASSES[doc.status];
  const dealLabel =
    doc.deal.target || doc.deal.projectName || "Unknown deal";
  const isDraft = doc.status === "DRAFT";
  // Signatures the backend auto-detected flip the doc to SIGNED and stamp
  // metadata.signatureDetectedVia (mirrors Gallery's badge logic).
  const autoDetectedSignature =
    doc.status === "SIGNED" &&
    Boolean(
      (doc.metadata as { signatureDetectedVia?: string } | undefined)
        ?.signatureDetectedVia,
    );

  // The /preview endpoint renders a read-only, chrome-free view of the Doc that
  // embeds cleanly in an iframe (the /edit URL refuses to frame). Guard on
  // googleDocId so a malformed row doesn't produce a broken src.
  const previewSrc = doc.googleDocId
    ? `https://docs.google.com/document/d/${doc.googleDocId}/preview`
    : null;

  function handleSent(resp: SendDocResponse) {
    setSendOpen(false);
    onSent({
      ...doc,
      status: "SENT",
      googleDocId: resp.googleDocId ?? doc.googleDocId,
      googleDocUrl: resp.googleDocUrl ?? doc.googleDocUrl,
      sentAt: resp.sentAt ?? doc.sentAt,
      sentToEmail: doc.sentToEmail,
    });
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
          aria-label="Back"
        >
          <span className="material-symbols-outlined text-[20px]">
            arrow_back
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-[#003366] font-medium truncate">
            {dealLabel}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">
              {doc.title}
            </h2>
            <span
              className={cn(
                "shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border",
                statusCls.bg,
                statusCls.text,
                statusCls.border,
              )}
            >
              {STATUS_LABELS[doc.status]}
            </span>
            <span
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600"
              title="This NDA lives in Google Docs — imported by URL"
            >
              <span className="material-symbols-outlined text-[12px]">
                cloud_done
              </span>
              Google Doc
            </span>
            {autoDetectedSignature && (
              <span
                className="shrink-0 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
                title="Signature auto-detected from the Google Doc lock — not marked Signed by hand"
              >
                <span className="material-symbols-outlined text-[12px]">
                  verified
                </span>
                Signed · auto-detected
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {doc.googleDocUrl && (
            <a
              href={doc.googleDocUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 rounded-md text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-100 inline-flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">
                open_in_new
              </span>
              Open in Google Docs
            </a>
          )}
          {isDraft && (
            <button
              type="button"
              onClick={() => setSendOpen(true)}
              className="px-4 py-2 rounded-md text-sm font-semibold text-white inline-flex items-center gap-1.5 hover:opacity-90"
              style={{ backgroundColor: "#003366" }}
            >
              <span className="material-symbols-outlined text-[16px]">send</span>
              Send
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          {isDraft ? (
            <SignatureHint />
          ) : (
            <SentStateBanner doc={doc} />
          )}

          {previewSrc ? (
            <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <iframe
                src={previewSrc}
                title={`Preview of ${doc.title}`}
                className="w-full block"
                style={{ height: "70vh" }}
              />
            </div>
          ) : (
            <MissingPreview docUrl={doc.googleDocUrl} />
          )}
        </div>
      </div>

      <SendModal
        open={sendOpen}
        doc={doc}
        onCancel={() => setSendOpen(false)}
        onSent={handleSent}
      />
    </div>
  );
}

/**
 * Draft-state hint. Tells the user the one thing they can only do externally:
 * add a Google-native eSignature field (no API exists for it).
 */
function SignatureHint() {
  return (
    <div className="rounded-lg px-4 py-3 border border-[#003366]/20 bg-[#E6EEF5]/50 text-slate-700 flex items-start gap-2">
      <span className="material-symbols-outlined text-[18px] mt-0.5 text-[#003366]">
        draw
      </span>
      <div className="text-xs leading-relaxed min-w-0">
        <span className="font-semibold text-slate-900">
          To add a signature field:
        </span>{" "}
        open this in Google Docs &rarr; <span className="font-medium">Tools</span>{" "}
        &rarr; <span className="font-medium">eSignature</span>, place the field,
        then come back and hit <span className="font-medium">Send</span>. Sending
        shares this exact Doc with the counterparty and emails them the link —
        no copy is made. We&rsquo;ll auto-detect their signature once they sign.
      </div>
    </div>
  );
}

/** SENT/SIGNED banner — the doc's already out, so no send CTA. */
function SentStateBanner({ doc }: { doc: LegalDocumentWithDeal }) {
  const isSigned = doc.status === "SIGNED";
  const recipient = doc.sentToEmail || doc.counterpartyEmail || "the counterparty";
  const when = doc.sentAt ? new Date(doc.sentAt).toLocaleString() : null;
  return (
    <div className="rounded-lg px-4 py-3 border border-emerald-200 bg-emerald-50 text-emerald-900 flex items-start gap-2">
      <span className="material-symbols-outlined text-[18px] mt-0.5 text-emerald-700">
        {isSigned ? "verified" : "check_circle"}
      </span>
      <div className="text-xs leading-snug min-w-0">
        <span className="font-semibold">
          {isSigned
            ? "This NDA has been signed."
            : `Sent to ${recipient}${when ? ` on ${when}` : ""}.`}
        </span>{" "}
        <span className="text-emerald-800/80">
          The Doc lives in Google Docs — open it above to view the latest.
        </span>
      </div>
    </div>
  );
}

/**
 * Fallback when there's no googleDocId to build a preview from (shouldn't
 * happen for an imported row, but degrade gracefully rather than render a
 * broken iframe). Offers the external link if we at least have a URL.
 */
function MissingPreview({ docUrl }: { docUrl: string | null }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="mx-auto w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <span className="material-symbols-outlined text-[28px]">
          description
        </span>
      </div>
      <div className="text-sm font-medium text-slate-700">
        Preview unavailable
      </div>
      <div className="text-[12px] text-slate-500 max-w-sm mx-auto mt-1">
        We couldn&rsquo;t build an embedded preview for this Doc.
        {docUrl && " Open it in Google Docs to view the contents."}
      </div>
      {docUrl && (
        <a
          href={docUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 px-3.5 py-2 rounded-md text-sm font-medium text-white hover:opacity-90 inline-flex items-center gap-1.5"
          style={{ backgroundColor: "#003366" }}
        >
          <span className="material-symbols-outlined text-[16px]">
            open_in_new
          </span>
          Open in Google Docs
        </a>
      )}
    </div>
  );
}

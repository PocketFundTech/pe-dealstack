"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { useUser } from "@/providers/UserProvider";
import { DownloadMenu, DraftEsignHint } from "./DownloadMenu";
import { Editor, type EditorHandle } from "./Editor";
import { SendModal } from "./SendModal";
import { SendForSignatureModal } from "./SendForSignatureModal";
import { SentActionBar } from "./SentActionBar";
import { TokenInsertPanel } from "./TokenInsertPanel";
import { useWorkspaceStatus } from "./useWorkspaceStatus";
import { STATUS_LABELS, STATUS_ORDER } from "./constants";
import { renderSignaturePlaceholder, substituteTokens } from "./tokens";
import { ViewModeToggle, type ViewMode } from "./ViewModeToggle";
import type {
  DocStatus,
  LegalDocument,
  LegalDocumentWithDeal,
  SendDocResponse,
  SendForSignatureResponse,
  UpdateDocBody,
} from "./types";

interface FullEditPageProps {
  doc: LegalDocumentWithDeal;
  onBack: () => void;
  onSaved: (updated: LegalDocument) => void;
}

interface FormState {
  title: string;
  content: string;
  status: DocStatus;
  counterpartyName: string;
  counterpartyEmail: string;
  counterpartyAddress: string;
  jurisdiction: string;
  effectiveDate: string;
  expiresAt: string;
  signedAt: string;
}

function initialForm(doc: LegalDocumentWithDeal): FormState {
  return {
    title: doc.title ?? "",
    content: doc.content ?? "",
    status: doc.status,
    counterpartyName: doc.counterpartyName ?? "",
    counterpartyEmail: doc.counterpartyEmail ?? "",
    counterpartyAddress: doc.counterpartyAddress ?? "",
    jurisdiction: doc.jurisdiction ?? "",
    effectiveDate: doc.effectiveDate ?? "",
    expiresAt: doc.expiresAt ?? "",
    signedAt: doc.signedAt ? toDatetimeLocal(doc.signedAt) : "",
  };
}

/**
 * Full-screen NDA editor (left = HTML body, right = metadata sidebar) —
 * inline in /nda, not a modal, because legal docs don't fit in a popup.
 * `status === "SENT"` defaults the left pane to read-only `contentSnapshot`
 * with a toggle back to the live draft.
 */
export function FullEditPage({ doc, onBack, onSaved }: FullEditPageProps) {
  const { showToast } = useToast();
  const { user } = useUser();
  // Connected Google account status — `isWorkspace` gates the Google Docs
  // eSignature "Request Signature" action in the sent-doc action bar.
  const workspace = useWorkspaceStatus();
  const editorRef = useRef<EditorHandle | null>(null);
  const [form, setForm] = useState<FormState>(() => initialForm(doc));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  // When viewing a SENT doc we default to the snapshot; user can toggle.
  const [showSnapshot, setShowSnapshot] = useState(doc.status === "SENT");
  // Edit shows raw `[TOKEN]` literals; Preview substitutes them with current
  // metadata so the user sees what the recipient gets.
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  // Sender Gmail from the most recent /send response (session-only — not persisted).
  const [lastSenderEmail, setLastSenderEmail] = useState<string | null>(null);

  // Reset on doc change. Watch `doc.id` / `doc.status` (not `doc`) so
  // parent state echoes on `handleSaved` don't wipe the form mid-typing.
  useEffect(() => {
    setForm(initialForm(doc));
    setShowSnapshot(doc.status === "SENT");
    setViewMode("edit");
    setError(null);
    setLastSenderEmail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.status]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const dealLabel = doc.deal.target || doc.deal.projectName || "Unknown deal";
  const isSent = form.status === "SENT";
  const hasSnapshot = !!doc.contentSnapshot;
  // googleDocUrl on a SENT doc => counterparty has live edit access in
  // Drive; surface the link + snapshot toggle in the emerald action bar.
  const hasGoogleDoc = isSent && !!doc.googleDocUrl;
  const isPreview = viewMode === "preview";
  // Save is only meaningful when we're editing — hide it in snapshot view
  // OR preview view (preview is read-only, no edits to persist).
  const showSaveButton = !(showSnapshot && hasSnapshot) && !isPreview;

  async function handleSave() {
    if (saving) return;
    const trimmedTitle = form.title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }
    setSaving(true);
    setError(null);
    const body: UpdateDocBody = {
      title: trimmedTitle,
      status: form.status,
      content: form.content,
      counterpartyName: form.counterpartyName.trim() || null,
      counterpartyEmail: form.counterpartyEmail.trim() || null,
      counterpartyAddress: form.counterpartyAddress.trim() || null,
      jurisdiction: form.jurisdiction.trim() || null,
      effectiveDate: form.effectiveDate || null,
      expiresAt: form.expiresAt || null,
      signedAt: form.signedAt ? new Date(form.signedAt).toISOString() : null,
    };
    try {
      const updated = await api.patch<LegalDocument>(
        `/legal-documents/${doc.id}`,
        body,
      );
      onSaved(updated);
      showToast("NDA saved", "success");
    } catch (err) {
      console.warn("[nda] save failed:", err);
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function handleSent(resp: SendDocResponse, toEmail: string) {
    setSendOpen(false);
    // Server has flipped status → SENT, frozen a snapshot, and made the
    // Google Doc copy. Mirror locally + bubble up so the gallery updates.
    const updated: LegalDocument = {
      ...doc,
      status: "SENT",
      sentAt: resp.sentAt,
      sentToEmail: toEmail || form.counterpartyEmail.trim() || doc.sentToEmail,
      // Snapshot will be the content we just sent.
      contentSnapshot: form.content,
      content: form.content,
      googleDocId: resp.googleDocId,
      googleDocUrl: resp.googleDocUrl,
    };
    onSaved(updated);
    setLastSenderEmail(resp.senderEmail);
    // Include sender Gmail in the toast — multi-tenant flow means From is
    // the user's own Workspace address, not a firm-wide domain.
    const successMsg = resp.alreadySent
      ? `Already sent — NDA delivered to ${toEmail} from ${resp.senderEmail}`
      : `NDA sent to ${toEmail} from ${resp.senderEmail}`;
    showToast(successMsg, "success");
    setForm((prev) => ({ ...prev, status: "SENT" }));
    setShowSnapshot(true);
  }

  function handleSignSent(resp: SendForSignatureResponse, toEmail: string) {
    setSignOpen(false);
    // Server rendered the PDF, dispatched the Dropbox Sign request, and
    // flipped status → SENT. Mirror locally + bubble up. The row goes SIGNED
    // later via the webhook once the counterparty signs.
    const updated: LegalDocument = {
      ...doc,
      status: "SENT",
      sentAt: resp.sentAt,
      sentToEmail: toEmail || doc.sentToEmail,
    };
    onSaved(updated);
    const mode = resp.testMode ? " (test mode)" : "";
    showToast(
      `Signature request sent to ${toEmail}${mode}`,
      "success",
    );
    setForm((prev) => ({ ...prev, status: "SENT" }));
  }

  const displayedContent = useMemo(() => {
    if (showSnapshot && hasSnapshot) return doc.contentSnapshot ?? "";
    if (isPreview) {
      // AppUser doesn't surface firmName yet (org-name lives on
      // /users/profile, not /users/me) — undefined renders the muted
      // "__firm name__" placeholder; picks up a real value once AppUser has it.
      const firmName = (user as { firmName?: string } | null)?.firmName;
      return renderSignaturePlaceholder(
        substituteTokens(form.content, {
          counterpartyName: form.counterpartyName,
          counterpartyAddress: form.counterpartyAddress,
          counterpartyEmail: form.counterpartyEmail,
          effectiveDate: form.effectiveDate,
          jurisdiction: form.jurisdiction,
          dealName: doc.deal?.target || doc.deal?.projectName,
          firmName,
        }),
      );
    }
    return form.content;
  }, [
    showSnapshot,
    hasSnapshot,
    doc.contentSnapshot,
    doc.deal,
    isPreview,
    form.content,
    form.counterpartyName,
    form.counterpartyAddress,
    form.counterpartyEmail,
    form.effectiveDate,
    form.jurisdiction,
    user,
  ]);

  return (
    <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
          aria-label="Back to gallery"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#003366] font-medium truncate">
            {dealLabel}
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate">
            {form.title || "Untitled NDA"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Edit / Preview segmented toggle. Orthogonal to the snapshot
              toggle: snapshot reads frozen `contentSnapshot`, preview reads
              live `content` with tokens replaced client-side. Hidden while
              viewing a frozen snapshot. */}
          {!(showSnapshot && hasSnapshot) && (
            <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
          )}
          {/* Snapshot toggle: fallback for SENT docs that pre-date Drive. */}
          {isSent && hasSnapshot && !hasGoogleDoc && (
            <button
              type="button"
              onClick={() => setShowSnapshot((s) => !s)}
              className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-200 text-slate-700 hover:bg-slate-100"
            >
              {showSnapshot ? "View current draft" : "View sent snapshot"}
            </button>
          )}
          <DownloadMenu
            docId={doc.id}
            title={form.title}
            disabled={!form.content.trim()}
          />
          {!isSent && <DraftEsignHint />}
          <button
            type="button"
            onClick={() => setSendOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs font-semibold text-[#003366] border border-[#003366]/30 hover:bg-[#E6EEF5]/50"
          >
            {hasGoogleDoc ? "Re-send via email" : "Send via email"}
          </button>
          <button
            type="button"
            onClick={() => setSignOpen(true)}
            disabled={!form.content.trim()}
            className="px-3 py-1.5 rounded-md text-xs font-semibold text-white inline-flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[14px]">
              draw
            </span>
            Send for signature
          </button>
          {showSaveButton && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-semibold text-white inline-flex items-center gap-1.5",
                saving ? "opacity-70 cursor-not-allowed" : "hover:opacity-90",
              )}
              style={{ backgroundColor: "#003366" }}
            >
              {saving && (
                <span className="material-symbols-outlined text-[14px] animate-spin">
                  progress_activity
                </span>
              )}
              Save
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left pane — editor */}
        <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
          {hasGoogleDoc && doc.googleDocUrl && (
            <SentActionBar
              docId={doc.id}
              sentToEmail={doc.sentToEmail}
              sentAt={doc.sentAt}
              googleDocUrl={doc.googleDocUrl}
              senderEmail={lastSenderEmail}
              showSnapshot={showSnapshot}
              onToggleView={() => setShowSnapshot((s) => !s)}
              isWorkspace={workspace.loading ? null : workspace.isWorkspace}
            />
          )}
          {error && (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
              <div className="flex-1 min-w-0">{error}</div>
            </div>
          )}
          {showSnapshot && hasSnapshot && hasGoogleDoc && (
            <div className="mb-3 rounded-lg px-3 py-2.5 text-xs border bg-amber-50 border-amber-200 text-amber-800 flex items-start gap-2">
              <span className="material-symbols-outlined text-[16px] mt-0.5">warning</span>
              <div className="flex-1 min-w-0 leading-snug">
                This is the version that was sent. Edits here won&rsquo;t
                propagate to the counterparty — open Google Docs for live
                edits.
              </div>
            </div>
          )}
          {showSnapshot && hasSnapshot && !hasGoogleDoc && (
            <div className="mb-3 rounded-lg px-3 py-2 text-xs border bg-amber-50 border-amber-200 text-amber-800 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">lock</span>
              Read-only — this is the exact version that was sent
              {doc.sentAt && (
                <span className="opacity-75">
                  on {new Date(doc.sentAt).toLocaleString()}
                </span>
              )}
              .
            </div>
          )}
          {isPreview && !(showSnapshot && hasSnapshot) && (
            <div className="mb-3 rounded-lg px-3 py-2.5 text-xs border bg-amber-50 border-amber-200 text-amber-800 flex items-start gap-2">
              <span className="material-symbols-outlined text-[16px] mt-0.5">
                visibility
              </span>
              <div className="flex-1 min-w-0 leading-snug">
                <span className="font-semibold">Preview mode</span> — this is
                what the recipient will see. Tokens are filled with the
                current counterparty info; switch back to{" "}
                <strong>Edit</strong> to change them.
              </div>
            </div>
          )}
          <div className="max-w-[820px] mx-auto bg-white shadow-sm rounded-md border border-slate-200">
            <Editor
              ref={editorRef}
              value={displayedContent}
              onChange={(html) => patch("content", html)}
              placeholder="Document body…"
              readOnly={(showSnapshot && hasSnapshot) || isPreview}
            />
          </div>
        </div>

        {/* Right pane — metadata sidebar */}
        <aside className="w-[340px] shrink-0 border-l border-slate-200 bg-white overflow-y-auto px-5 py-6 space-y-4">
          <Field label="Title" required>
            <input
              value={form.title}
              onChange={(e) => patch("title", e.target.value)}
              className={inputCls}
              required
            />
          </Field>

          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => patch("status", e.target.value as DocStatus)}
              className={inputCls}
            >
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Counterparty name">
            <input
              value={form.counterpartyName}
              onChange={(e) => patch("counterpartyName", e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Counterparty email">
            <input
              type="email"
              value={form.counterpartyEmail}
              onChange={(e) => patch("counterpartyEmail", e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Counterparty address">
            <textarea
              value={form.counterpartyAddress}
              onChange={(e) => patch("counterpartyAddress", e.target.value)}
              rows={3}
              className={cn(inputCls, "resize-y")}
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

          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective date">
              <input
                type="date"
                value={form.effectiveDate}
                onChange={(e) => patch("effectiveDate", e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Expires at">
              <input
                type="date"
                value={form.expiresAt}
                onChange={(e) => patch("expiresAt", e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          {form.status === "SIGNED" && (
            <Field label="Signed at">
              <input
                type="datetime-local"
                value={form.signedAt}
                onChange={(e) => patch("signedAt", e.target.value)}
                className={inputCls}
              />
            </Field>
          )}

          {/* Insertable `[TOKEN_KEY]` placeholders (backend substitutes on
              send). Disabled in snapshot/preview — editor is read-only. */}
          <TokenInsertPanel
            bodyHtml={form.content}
            editorRef={editorRef}
            disabled={(showSnapshot && hasSnapshot) || isPreview}
          />

          {doc.sentAt && (
            <div className="pt-3 border-t border-slate-100 text-[11px] text-slate-500 space-y-0.5">
              <div>
                <span className="font-medium text-slate-700">Sent:</span>{" "}
                {new Date(doc.sentAt).toLocaleString()}
              </div>
              {doc.sentToEmail && (
                <div className="truncate">
                  <span className="font-medium text-slate-700">To:</span>{" "}
                  {doc.sentToEmail}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <SendModal
        open={sendOpen}
        doc={doc}
        onCancel={() => setSendOpen(false)}
        onSent={handleSent}
      />

      <SendForSignatureModal
        open={signOpen}
        doc={doc}
        onCancel={() => setSignOpen(false)}
        onSent={handleSignSent}
      />
    </div>
  );
}

// ISO → "YYYY-MM-DDTHH:MM" in local time for <input type="datetime-local">.
// `.toISOString().slice(0, 16)` would render UTC; we want wall clock.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
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


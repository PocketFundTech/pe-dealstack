"use client";

import { useEffect, useState, type FormEvent } from "react";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import {
  OUTREACH_CHANNELS,
  CHANNEL_CONFIG,
  REPLY_INTENT_CONFIG,
  SOURCE_PROVIDER_CONFIG,
  sortStagesByPosition,
  type OutreachContact,
  type OutreachContactFormValues,
  type OutreachStage,
} from "./types";

const inputCls =
  "w-full rounded-lg border border-border-subtle bg-white px-3 py-2 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors";

// ---------------------------------------------------------------------------
// Add / edit modal for an outreach contact. In edit mode it also surfaces a
// Delete action (confirmation is handled by the parent via ConfirmDialog, per
// CLAUDE.md — never window.confirm).
// ---------------------------------------------------------------------------
export function ContactFormModal({
  mode,
  contact,
  stages,
  initialValues,
  saving,
  onSave,
  onDelete,
  onClose,
  enriching,
  onEnrich,
  markingReviewed,
  onMarkReviewed,
  confirmingMatchReview,
  onConfirmMatchReview,
}: {
  mode: "create" | "edit";
  /** Present only in edit mode — used for the read-only metadata footer. */
  contact?: OutreachContact | null;
  stages: OutreachStage[];
  initialValues: OutreachContactFormValues;
  saving: boolean;
  onSave: (values: OutreachContactFormValues) => void;
  onDelete?: () => void;
  onClose: () => void;
  /** True while an enrichment call for this contact is in flight. */
  enriching?: boolean;
  /** Present only in edit mode — triggers POST /outreach/contacts/:id/enrich. */
  onEnrich?: () => void;
  /** True while a "Mark reviewed" call for this contact is in flight. */
  markingReviewed?: boolean;
  /** Present only in edit mode — clears needsReview via PATCH /outreach/contacts/:id. */
  onMarkReviewed?: () => void;
  /** True while a "Confirm as new contact" call for this contact is in flight. */
  confirmingMatchReview?: boolean;
  /** Present only in edit mode — clears needsMatchReview via PATCH
   *  /outreach/contacts/:id. Distinct from onMarkReviewed: this resolves the
   *  Private Circle import's duplicate-detection flag, not reply-intent
   *  review. No merge action here by design — combining duplicate records
   *  stays a manual, out-of-band step. */
  onConfirmMatchReview?: () => void;
}) {
  const [form, setForm] = useState<OutreachContactFormValues>(initialValues);
  const orderedStages = sortStagesByPosition(stages);

  // Enrichment runs while this modal stays open (see the "Enrich" button
  // below) and resolves to an updated `contact` prop, not a form reset —
  // pull the newly-populated title/LinkedIn straight into the form so the
  // user sees them without closing and reopening the modal.
  useEffect(() => {
    if (mode !== "edit" || !contact) return;
    setForm((f) => ({
      ...f,
      title: contact.title || f.title,
      linkedinUrl: contact.linkedinUrl || f.linkedinUrl,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.enrichedAt]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.stageId) return;
    onSave({ ...form, name: form.name.trim() });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface-card rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle sticky top-0 bg-surface-card z-10">
          <div>
            <h3 className="text-lg font-bold text-text-main">
              {mode === "edit" ? "Edit Contact" : "Add Contact"}
            </h3>
            {mode === "edit" && contact?.sourceProvider && SOURCE_PROVIDER_CONFIG[contact.sourceProvider] && (
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-text-muted">
                <span className="material-symbols-outlined text-[12px]">
                  {SOURCE_PROVIDER_CONFIG[contact.sourceProvider]!.icon}
                </span>
                {SOURCE_PROVIDER_CONFIG[contact.sourceProvider]!.label}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-main transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
          {mode === "edit" && contact?.needsMatchReview && (
            <div className="rounded-lg border border-violet-300 bg-violet-50 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px] text-violet-700">content_copy</span>
                <span className="text-xs font-bold uppercase tracking-wider text-violet-700">
                  Possible Duplicate
                </span>
              </div>
              {contact.matchReviewReason ? (
                <p className="text-sm text-violet-900 whitespace-pre-wrap">{contact.matchReviewReason}</p>
              ) : (
                <p className="text-sm text-violet-700 italic">
                  Flagged as a possible duplicate during the Private Circle import.
                </p>
              )}
              {onConfirmMatchReview && (
                <button
                  type="button"
                  onClick={onConfirmMatchReview}
                  disabled={confirmingMatchReview}
                  className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-300 text-violet-700 text-xs font-medium hover:bg-violet-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[14px]",
                      confirmingMatchReview && "animate-spin",
                    )}
                  >
                    {confirmingMatchReview ? "progress_activity" : "check_circle"}
                  </span>
                  {confirmingMatchReview ? "Confirming..." : "Confirm as new contact"}
                </button>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputCls}
              placeholder="Jane Smith"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">
                Stage <span className="text-red-500">*</span>
              </label>
              <select
                required
                value={form.stageId}
                onChange={(e) => setForm((f) => ({ ...f, stageId: e.target.value }))}
                className={inputCls}
              >
                {orderedStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Channel</label>
              <select
                value={form.channel}
                onChange={(e) =>
                  setForm((f) => ({ ...f, channel: e.target.value as OutreachContactFormValues["channel"] }))
                }
                className={inputCls}
              >
                {OUTREACH_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_CONFIG[c].label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Company</label>
              <input
                type="text"
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                className={inputCls}
                placeholder="Acme Holdings"
              />
              {mode === "edit" && contact?.cin && (
                <p className="mt-1 text-[11px] text-text-muted">
                  CIN: <span className="font-mono">{contact.cin}</span>
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className={inputCls}
                placeholder="VP of Corporate Development"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className={inputCls}
                placeholder="jane@acme.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                className={inputCls}
                placeholder="+1 (555) 123-4567"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">LinkedIn URL</label>
            <input
              type="url"
              value={form.linkedinUrl}
              onChange={(e) => setForm((f) => ({ ...f, linkedinUrl: e.target.value }))}
              className={inputCls}
              placeholder="https://linkedin.com/in/janesmith"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              className={cn(inputCls, "resize-none")}
              placeholder="Any additional context about this contact..."
            />
          </div>

          {mode === "edit" && contact && (contact.lastReplyText || contact.replyIntent || contact.needsReview) && (
            <div className="rounded-lg border border-border-subtle bg-background-body p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">
                  Latest Reply
                </span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {contact.needsReview && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-bold border border-amber-300"
                      title="Needs review — reply intent unclear"
                    >
                      <span className="material-symbols-outlined text-[12px]">warning</span>
                      Needs review
                    </span>
                  )}
                  {contact.replyIntent && (
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full border text-[10px] font-medium",
                        REPLY_INTENT_CONFIG[contact.replyIntent].bg,
                        REPLY_INTENT_CONFIG[contact.replyIntent].border,
                        REPLY_INTENT_CONFIG[contact.replyIntent].text,
                      )}
                    >
                      {REPLY_INTENT_CONFIG[contact.replyIntent].label}
                    </span>
                  )}
                </div>
              </div>
              {contact.lastReplyText ? (
                <p className="text-sm text-text-main whitespace-pre-wrap">{contact.lastReplyText}</p>
              ) : (
                <p className="text-sm text-text-muted italic">No reply text available.</p>
              )}
              {contact.needsReview && onMarkReviewed && (
                <button
                  type="button"
                  onClick={onMarkReviewed}
                  disabled={markingReviewed}
                  className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 text-xs font-medium hover:bg-amber-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[14px]",
                      markingReviewed && "animate-spin",
                    )}
                  >
                    {markingReviewed ? "progress_activity" : "check_circle"}
                  </span>
                  {markingReviewed ? "Marking..." : "Mark reviewed"}
                </button>
              )}
            </div>
          )}

          {mode === "edit" && contact && (
            <p className="text-[11px] text-text-muted border-t border-border-subtle pt-3">
              Added {formatRelativeTime(contact.createdAt)}
              {contact.updatedAt !== contact.createdAt && ` · Updated ${formatRelativeTime(contact.updatedAt)}`}
              {contact.enrichedAt && ` · Enriched ${formatRelativeTime(contact.enrichedAt)}`}
              {contact.enrichedAt && contact.enrichmentSource?.length
                ? ` (via ${contact.enrichmentSource.join(", ")})`
                : ""}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            {mode === "edit" ? (
              <div className="flex items-center gap-2">
                {onEnrich && (
                  <button
                    type="button"
                    onClick={onEnrich}
                    disabled={enriching}
                    className="px-4 py-2 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-primary-light hover:text-[#003366] hover:border-primary/30 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span
                      className={cn(
                        "material-symbols-outlined text-[16px]",
                        enriching && "animate-spin",
                      )}
                    >
                      {enriching ? "progress_activity" : "auto_awesome"}
                    </span>
                    {enriching ? "Enriching..." : "Enrich"}
                  </button>
                )}
                {onDelete && (
                  <button
                    type="button"
                    onClick={onDelete}
                    className="px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors flex items-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete</span>
                    Delete
                  </button>
                )}
              </div>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || !form.name.trim() || !form.stageId}
                className="px-5 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 flex items-center gap-2"
                style={{ backgroundColor: "#003366" }}
              >
                <span>{saving ? "Saving..." : mode === "edit" ? "Save Changes" : "Add Contact"}</span>
                {saving && (
                  <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

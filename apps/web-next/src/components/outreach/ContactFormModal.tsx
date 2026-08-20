"use client";

import { useState, type FormEvent } from "react";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import {
  OUTREACH_CHANNELS,
  CHANNEL_CONFIG,
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
}) {
  const [form, setForm] = useState<OutreachContactFormValues>(initialValues);
  const orderedStages = sortStagesByPosition(stages);

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
          <h3 className="text-lg font-bold text-text-main">
            {mode === "edit" ? "Edit Contact" : "Add Contact"}
          </h3>
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

          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">Company</label>
            <input
              type="text"
              value={form.company}
              onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              className={inputCls}
              placeholder="Acme Holdings"
            />
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
            <label className="block text-sm font-medium text-text-main mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              className={cn(inputCls, "resize-none")}
              placeholder="Any additional context about this contact..."
            />
          </div>

          {mode === "edit" && contact && (
            <p className="text-[11px] text-text-muted border-t border-border-subtle pt-3">
              Added {formatRelativeTime(contact.createdAt)}
              {contact.updatedAt !== contact.createdAt && ` · Updated ${formatRelativeTime(contact.updatedAt)}`}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            {mode === "edit" && onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors flex items-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                Delete
              </button>
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

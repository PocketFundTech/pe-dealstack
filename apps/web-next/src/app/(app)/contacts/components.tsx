"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { api, NotFoundError } from "@/lib/api";
import { STORAGE_KEYS } from "@/lib/storageKeys";

// ─── Shared Types & Constants ──────────────────────────────

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  title?: string;
  type: string;
  notes: string;
  tags?: string[];
  linkedinUrl?: string;
  lastInteractionAt?: string;
  followUpAt?: string | null;
  interactions?: Interaction[];
  linkedDeals?: LinkedDeal[];
  createdAt: string;
  updatedAt: string;
  /** Raw HubSpot properties kept verbatim by the importer; absent for non-imported contacts. */
  hubspotProperties?: Record<string, string | null> | null;
}

export interface Interaction {
  id: string;
  type: string;
  title: string;
  notes?: string;
  date: string;
  createdAt: string;
  Contact?: { id: string; firstName: string; lastName: string; type: string; company?: string };
}

export interface LinkedDeal {
  dealId: string;
  role?: string;
  deal: { id: string; name: string; stage: string };
}

export const CONTACT_TYPES = ["BANKER", "ADVISOR", "EXECUTIVE", "LP", "LEGAL", "OTHER"] as const;

export const TYPE_CONFIG: Record<string, { label: string; bg: string; text: string; avatarBg: string; avatarText: string }> = {
  BANKER:    { label: "Banker",    bg: "bg-blue-100",    text: "text-blue-700",    avatarBg: "#DBEAFE", avatarText: "#1D4ED8" },
  ADVISOR:   { label: "Advisor",   bg: "bg-purple-100",  text: "text-purple-700",  avatarBg: "#EDE9FE", avatarText: "#6D28D9" },
  EXECUTIVE: { label: "Executive", bg: "bg-emerald-100", text: "text-emerald-700", avatarBg: "#D1FAE5", avatarText: "#047857" },
  LP:        { label: "LP",        bg: "bg-amber-100",   text: "text-amber-700",   avatarBg: "#FEF3C7", avatarText: "#B45309" },
  LEGAL:     { label: "Legal",     bg: "bg-slate-100",   text: "text-slate-700",   avatarBg: "#F1F5F9", avatarText: "#334155" },
  OTHER:     { label: "Other",     bg: "bg-gray-100",    text: "text-gray-700",    avatarBg: "#F3F4F6", avatarText: "#374151" },
};

export const SCORE_CONFIG: Record<string, { bg: string; text: string; dot: string; icon: string }> = {
  Cold:   { bg: "bg-gray-100",    text: "text-gray-600",    dot: "bg-gray-400",    icon: "ac_unit" },
  Warm:   { bg: "bg-amber-100",   text: "text-amber-700",   dot: "bg-amber-500",   icon: "sunny" },
  Hot:    { bg: "bg-red-100",     text: "text-red-700",     dot: "bg-red-500",     icon: "local_fire_department" },
  Active: { bg: "bg-emerald-100", text: "text-emerald-700", dot: "bg-emerald-500", icon: "bolt" },
  Strong: { bg: "bg-green-100",   text: "text-green-800",   dot: "bg-green-600",   icon: "star" },
};

// Imported from shared formatters and re-exported for contacts/page.tsx
import { getInitials } from "@/lib/formatters";
export { getInitials };

export function getRelationshipLabel(score: number | null | undefined): string {
  if (!score && score !== 0) return "Cold";
  if (score >= 75) return "Strong";
  if (score >= 50) return "Active";
  if (score >= 25) return "Warm";
  return "Cold";
}

// ─── Contact Modal ─────────────────────────────────────────

export interface ContactFormData {
  firstName: string; lastName: string; email: string; phone: string;
  title: string; company: string; type: string; linkedinUrl: string;
  tags: string[]; notes: string;
}

export function ContactModal({
  contact, saving, onSave, onClose,
}: {
  contact: Contact | null;
  saving: boolean;
  onSave: (data: ContactFormData) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    firstName: contact?.firstName || "", lastName: contact?.lastName || "",
    email: contact?.email || "", phone: contact?.phone || "",
    title: contact?.title || "", company: contact?.company || "",
    type: contact?.type || "", linkedinUrl: contact?.linkedinUrl || "",
    tagsRaw: (contact?.tags || []).join(", "), notes: contact?.notes || "",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim()) return;
    const tags = form.tagsRaw ? form.tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
    let linkedinUrl = form.linkedinUrl.trim();
    if (linkedinUrl && !linkedinUrl.startsWith("http")) linkedinUrl = "https://" + linkedinUrl;
    onSave({ firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone, title: form.title, company: form.company, type: form.type, linkedinUrl, tags, notes: form.notes });
  }

  const inputCls = "w-full rounded-lg border border-border-subtle bg-white px-3 py-2 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md" onClick={onClose}>
      <div className="bg-surface-card rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle sticky top-0 bg-surface-card z-10">
          <h3 className="text-lg font-bold text-text-main">{contact ? "Edit Contact" : "Add Contact"}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-main transition-colors">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">First Name <span className="text-red-500">*</span></label>
              <input type="text" required value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} className={inputCls} placeholder="John" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Last Name <span className="text-red-500">*</span></label>
              <input type="text" required value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} className={inputCls} placeholder="Doe" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={inputCls} placeholder="john@example.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Phone</label>
              <input type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="+1 (555) 123-4567" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Title</label>
              <input type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} className={inputCls} placeholder="Managing Director" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Company</label>
              <input type="text" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} className={inputCls} placeholder="Goldman Sachs" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">Type <span className="text-red-500">*</span></label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className={inputCls} required>
                <option value="">Select type...</option>
                {CONTACT_TYPES.map((t) => <option key={t} value={t}>{TYPE_CONFIG[t].label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-main mb-1.5">LinkedIn URL</label>
              <input type="text" value={form.linkedinUrl} onChange={(e) => setForm((f) => ({ ...f, linkedinUrl: e.target.value }))} className={inputCls} placeholder="https://linkedin.com/in/..." />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">Tags <span className="text-text-muted font-normal">(comma-separated)</span></label>
            <input type="text" value={form.tagsRaw} onChange={(e) => setForm((f) => ({ ...f, tagsRaw: e.target.value }))} className={inputCls} placeholder="healthcare, m&a, midwest" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-main mb-1.5">Notes</label>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={3} className={cn(inputCls, "resize-none")} placeholder="Any additional notes about this contact..." />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-gray-50 transition-colors">Cancel</button>
            <button type="submit" disabled={saving || !form.firstName.trim()} className="px-5 py-2 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-colors disabled:opacity-50 flex items-center gap-2" style={{ backgroundColor: "#003366" }}>
              <span>{saving ? "Saving..." : contact ? "Update Contact" : "Save Contact"}</span>
              {saving && <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete Confirmation Modal ─────────────────────────────

export function DeleteConfirmModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="bg-surface-card rounded-xl shadow-lg p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="size-10 rounded-full bg-red-100 flex items-center justify-center">
            <span className="material-symbols-outlined text-red-600 text-[20px]">warning</span>
          </div>
          <div>
            <h3 className="font-semibold text-text-main">Delete Contact</h3>
            <p className="text-sm text-text-muted">This action cannot be undone.</p>
          </div>
        </div>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium rounded-lg border border-border-subtle text-text-secondary hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors">Delete</button>
        </div>
      </div>
    </div>
  );
}

// ─── Needs Attention (stale contacts) ──────────────────────
//
// Surfaces `GET /contacts/insights/stale` on the contacts list page. The
// endpoint returns contacts that have never been contacted or haven't been
// contacted within the threshold window. Previously this endpoint had no UI
// caller. The card hides entirely when there are no stale contacts, when Gmail
// isn't connected (endpoint may report `connected: false`), when the endpoint
// 404s (NotFoundError → treated as empty), or when the banker dismisses it for
// the session.

const STALE_TOP_N = 5;

interface StaleContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  type?: string | null;
  company?: string | null;
  email?: string | null;
  lastContactedAt?: string | null;
  reason?: string | null;
}

interface StaleResponse {
  contacts?: StaleContact[];
  threshold?: number;
  connected?: boolean;
}

function staleContactName(c: StaleContact): string {
  const name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
  return name || c.email || "Unnamed contact";
}

function staleTiming(c: StaleContact): string {
  if (!c.lastContactedAt) return "Never contacted";
  const days = Math.floor((Date.now() - new Date(c.lastContactedAt).getTime()) / 86400000);
  if (days <= 0) return "Contacted today";
  return `${days}d since last contact`;
}

function StaleItem({ c, onOpen }: { c: StaleContact; onOpen: (id: string) => void }) {
  const neverContacted = !c.lastContactedAt;
  return (
    <button
      onClick={() => onOpen(c.id)}
      className="flex items-center justify-between gap-3 w-full text-left px-3 py-2 rounded-lg bg-surface-card border border-border-subtle hover:border-primary/30 hover:shadow-sm transition-all"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-main truncate">{staleContactName(c)}</p>
        {c.company && <p className="text-xs text-text-muted truncate">{c.company}</p>}
      </div>
      <span
        className={cn(
          "shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold",
          neverContacted ? "bg-slate-100 text-slate-600" : "bg-orange-50 text-orange-600"
        )}
      >
        {staleTiming(c)}
      </span>
    </button>
  );
}

export function InsightCards({ onOpenContact }: { totalContacts: number; onOpenContact: (id: string) => void }) {
  const [contacts, setContacts] = useState<StaleContact[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Lazy-init from sessionStorage so we don't sync state in an effect
  // (matches the quick-notes widget idiom).
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEYS.contactsStaleDismissed) === "1";
    } catch (err) {
      console.warn("[contacts] stale dismiss read failed:", err);
      return false;
    }
  });

  useEffect(() => {
    let active = true;
    api
      .get<StaleResponse>("/contacts/insights/stale")
      .then((res) => {
        if (!active) return;
        // `connected: false` (Gmail not connected) → hide entirely.
        setContacts(res.connected === false ? [] : res.contacts || []);
      })
      .catch((err) => {
        if (!active) return;
        // 404 → endpoint not available; treat as empty/hidden, not an error.
        if (!(err instanceof NotFoundError)) {
          console.warn("[contacts] stale load failed:", err);
        }
        setContacts([]);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      sessionStorage.setItem(STORAGE_KEYS.contactsStaleDismissed, "1");
    } catch (err) {
      console.warn("[contacts] stale dismiss write failed:", err);
    }
  }

  if (dismissed) return null;

  // Loading: lightweight skeleton, never a blocking spinner.
  if (loading) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface-card p-4 flex flex-col gap-3">
        <div className="h-4 w-40 rounded bg-slate-100 animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
          <div className="h-12 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      </div>
    );
  }

  // Empty / not connected / 404 → hide the card.
  if (!contacts || contacts.length === 0) return null;

  const top = contacts.slice(0, STALE_TOP_N);

  return (
    <div className="rounded-xl border border-orange-200 bg-orange-50/30 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-orange-600 text-[20px]">schedule</span>
          <h2 className="text-sm font-bold text-text-main">Needs attention</h2>
          <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[11px] font-bold">
            {contacts.length} stale
          </span>
        </div>
        <button
          onClick={dismiss}
          className="text-text-muted hover:text-text-secondary transition-colors"
          title="Dismiss"
          aria-label="Dismiss needs attention"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {top.map((c) => <StaleItem key={c.id} c={c} onOpen={onOpenContact} />)}
      </div>
    </div>
  );
}


"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatRelativeTime, getInitials } from "@/lib/formatters";
import { useToast } from "@/providers/ToastProvider";

// ─── Add contacts from your inbox ───────────────────────────
//
// Surfaces `GET /contacts/insights/gmail-suggestions` on the contacts list
// page: people the user emails with who aren't yet saved as contacts. Each
// suggestion has an inline "Add" button that creates the contact via the
// existing `POST /contacts` endpoint, then drops out of the list. The section
// is loaded lazily (after the list renders) so it never blocks initial paint.

interface GmailSuggestion {
  email: string;
  name: string | null;
  company: string | null;
  emailCount: number;
  lastEmailDate: string;
}

interface GmailSuggestionsResponse {
  connected: boolean;
  scanned: boolean;
  suggestions: GmailSuggestion[];
}

// Split a free-text display name into first/last; fall back to the email
// local-part when there's no name (matches the contract's fallback rule).
function splitName(name: string | null, email: string): { firstName: string; lastName: string } {
  const trimmed = (name || "").trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    const firstName = parts.shift() || trimmed;
    return { firstName, lastName: parts.join(" ") };
  }
  const local = (email.split("@")[0] || email).replace(/[._-]+/g, " ").trim();
  const parts = local.split(/\s+/);
  const firstName = parts.shift() || local;
  return { firstName, lastName: parts.join(" ") };
}

function displayName(s: GmailSuggestion): string {
  return (s.name || "").trim() || s.email.split("@")[0] || s.email;
}

function SuggestionRow({
  suggestion,
  adding,
  onAdd,
  onDismiss,
}: {
  suggestion: GmailSuggestion;
  adding: boolean;
  onAdd: (s: GmailSuggestion) => void;
  onDismiss: (email: string) => void;
}) {
  const name = displayName(suggestion);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-card border border-border-subtle hover:border-primary/30 hover:shadow-sm transition-all">
      <div className="size-9 rounded-full bg-blue-50 text-blue-700 flex items-center justify-center shrink-0 text-xs font-bold">
        {getInitials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-main truncate">{name}</p>
        <p className="text-xs text-text-muted truncate">
          {suggestion.email}
          {suggestion.company ? ` · ${suggestion.company}` : ""}
        </p>
      </div>
      <div className="hidden sm:flex flex-col items-end shrink-0 text-right">
        <span className="text-[11px] font-semibold text-text-secondary">
          {suggestion.emailCount} email{suggestion.emailCount !== 1 ? "s" : ""}
        </span>
        {suggestion.lastEmailDate && (
          <span className="text-[10px] text-text-muted">{formatRelativeTime(suggestion.lastEmailDate)}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onAdd(suggestion)}
          disabled={adding}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          style={{ backgroundColor: "#003366" }}
        >
          {adding ? (
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
          ) : (
            <span className="material-symbols-outlined text-[16px]">person_add</span>
          )}
          Add
        </button>
        <button
          onClick={() => onDismiss(suggestion.email)}
          className="p-1.5 rounded-lg text-text-muted hover:bg-gray-100 hover:text-text-secondary transition-colors"
          title="Dismiss suggestion"
          aria-label={`Dismiss ${name}`}
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>
    </div>
  );
}

const MAX_VISIBLE = 6;

// POST /contacts returns 409 when a contact with the same email already exists
// in the org (e.g. a double-clicked suggestion, or it was added elsewhere). We
// treat that as success: the contact is in the list, so drop the suggestion.
const HTTP_CONFLICT = 409;

export function GmailSuggestions({ onContactAdded }: { onContactAdded?: () => void }) {
  const { showToast } = useToast();
  const [data, setData] = useState<GmailSuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [addingEmail, setAddingEmail] = useState<string | null>(null);
  const [dismissedEmails, setDismissedEmails] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await api.get<GmailSuggestionsResponse>("/contacts/insights/gmail-suggestions");
      setData(res);
    } catch (err) {
      // Treat a missing/unavailable endpoint as "no suggestions" — never block
      // the page or surface a scary error for an optional enhancement.
      console.warn("[contacts] gmail suggestions load failed:", err);
      setData({ connected: false, scanned: false, suggestions: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy: defer the fetch until after the list has had a chance to render.
  useEffect(() => {
    let active = true;
    const id = setTimeout(() => {
      if (active) load();
    }, 400);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [load]);

  async function handleScan() {
    setScanning(true);
    try {
      const res = await api.get<GmailSuggestionsResponse>("/contacts/insights/gmail-suggestions");
      setData(res);
      setDismissedEmails(new Set());
    } catch (err) {
      console.warn("[contacts] gmail suggestions scan failed:", err);
      showToast("Couldn't scan your inbox right now", "error");
    } finally {
      setScanning(false);
    }
  }

  // Remove a suggestion from the list once it's been added (or already exists).
  function removeSuggestion(email: string) {
    setData((prev) =>
      prev ? { ...prev, suggestions: prev.suggestions.filter((x) => x.email !== email) } : prev,
    );
  }

  async function handleAdd(s: GmailSuggestion) {
    // Guard against double-clicks: the button is disabled while in flight, but
    // bail early too so a rapid second invocation never fires a second request.
    if (addingEmail === s.email) return;
    setAddingEmail(s.email);
    try {
      const { firstName, lastName } = splitName(s.name, s.email);
      await api.post("/contacts", {
        firstName,
        lastName,
        email: s.email,
        ...(s.company ? { company: s.company } : {}),
      });
      removeSuggestion(s.email);
      showToast(`Added ${displayName(s)} to contacts`, "success");
      onContactAdded?.();
    } catch (err) {
      // 409 = the contact already exists (race on a double-click, or added
      // elsewhere). Treat as success: drop it from the list and tell the user.
      if (err instanceof ApiError && err.status === HTTP_CONFLICT) {
        removeSuggestion(s.email);
        showToast("Already in your contacts", "success");
        onContactAdded?.();
        return;
      }
      showToast(err instanceof Error ? err.message : "Failed to add contact", "error");
    } finally {
      setAddingEmail(null);
    }
  }

  function handleDismiss(email: string) {
    setDismissedEmails((prev) => {
      const next = new Set(prev);
      next.add(email);
      return next;
    });
  }

  if (loading || dismissed || !data) return null;

  // Not connected → subtle hint, no list.
  if (!data.connected) {
    return (
      <div className="rounded-xl border border-border-subtle bg-slate-50/60 px-4 py-3 flex items-center gap-2.5 text-sm text-text-secondary">
        <span className="material-symbols-outlined text-text-muted text-[18px]">mail</span>
        <span>Connect Gmail to find contacts from your inbox.</span>
      </div>
    );
  }

  const visibleSuggestions = data.suggestions.filter((s) => !dismissedEmails.has(s.email));
  if (visibleSuggestions.length === 0) return null;

  const shown = expanded ? visibleSuggestions : visibleSuggestions.slice(0, MAX_VISIBLE);
  const hiddenCount = visibleSuggestions.length - shown.length;

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-blue-600 text-[20px]">forward_to_inbox</span>
          <h2 className="text-sm font-bold text-text-main">Add contacts from your inbox</h2>
          <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-bold">
            {visibleSuggestions.length} suggested
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-text-secondary text-xs font-medium hover:bg-white/70 transition-colors disabled:opacity-50"
            title="Re-scan inbox"
          >
            <span className={cn("material-symbols-outlined text-[16px]", scanning && "animate-spin")}>sync</span>
            {scanning ? "Scanning..." : "Scan inbox"}
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-text-muted hover:text-text-secondary transition-colors p-1"
            title="Dismiss"
            aria-label="Dismiss inbox suggestions"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {shown.map((s) => (
          <SuggestionRow
            key={s.email}
            suggestion={s}
            adding={addingEmail === s.email}
            onAdd={handleAdd}
            onDismiss={handleDismiss}
          />
        ))}
      </div>

      {(hiddenCount > 0 || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-xs font-medium text-primary hover:underline"
        >
          {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}

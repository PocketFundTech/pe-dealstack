"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Deal } from "@/types";

interface DealPickerProps {
  open: boolean;
  onCancel: () => void;
  onSelect: (deal: PickableDeal) => void;
}

// What the Builder needs from a deal: the id (to scope graphs) and a human
// label for the subheader. We accept any fields the API returns and derive
// the label client-side so the picker stays resilient to schema drift.
export interface PickableDeal {
  id: string;
  label: string;
}

// Display label precedence: companyName (from the joined company row) → name
// (the deal's own title) → a placeholder. Mirrors how DealCard renders the
// title in the deals list so the picker feels familiar.
function dealLabel(d: Deal): string {
  return d.companyName || d.company?.name || d.name || "Untitled deal";
}

// Secondary line shown under the primary label. We only render it when it
// adds information (i.e. when the project name differs from the company name
// the picker is already showing). The legacy app calls this the "Project"
// field; here it maps to `Deal.name`.
function dealSecondary(d: Deal): string | null {
  const primary = dealLabel(d);
  if (d.name && d.name !== primary) return d.name;
  return null;
}

export function DealPicker({ open, onCancel, onSelect }: DealPickerProps) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const loadDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Pull the first 100 so the picker can fuzzy-filter client-side without
      // a round-trip per keystroke. Most users have far fewer; if a firm ever
      // has >100 active deals we'll add server-side search.
      const data = await api.get<Deal[]>("/deals?limit=100&sortBy=updatedAt&sortOrder=desc");
      const raw = Array.isArray(data) ? data : [];
      // Flatten company.name into companyName so the label helper above can
      // read either field — matches the same massaging the deals page does.
      setDeals(
        raw.map((d) => ({
          ...d,
          companyName: d.companyName || d.company?.name || undefined,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load deals");
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-fetch every time the modal opens so a freshly-created deal shows up
  // without a full page reload. Cheap (one paginated request) and we throw
  // the results away when the modal closes anyway.
  useEffect(() => {
    if (!open) return;
    setSearch("");
    loadDeals();
  }, [open, loadDeals]);

  // Close on Escape — same affordance ConfirmDialog gives.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return deals;
    return deals.filter((d) => {
      const haystack = [d.name, d.companyName, d.company?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [deals, search]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-slate-900">Pick a deal</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Graphs are scoped to a single deal — choose which one to build for.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-4 pb-3 shrink-0">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[18px]">
              search
            </span>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by deal or company name"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-slate-200 focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15 outline-none"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {loading ? (
            <div className="py-10 flex flex-col items-center justify-center text-slate-500">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[#003366] mb-3" />
              <span className="text-xs">Loading deals…</span>
            </div>
          ) : error ? (
            <div className="my-2 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-700">
              <span className="material-symbols-outlined text-[18px]">error</span>
              {error}
            </div>
          ) : deals.length === 0 ? (
            <EmptyNoDeals />
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              No deals match &ldquo;{search}&rdquo;.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {filtered.map((d) => {
                const primary = dealLabel(d);
                const secondary = dealSecondary(d);
                return (
                  <li key={d.id}>
                    <button
                      onClick={() => onSelect({ id: d.id, label: buildBuilderLabel(d) })}
                      className={cn(
                        "w-full text-left py-3 px-2 -mx-2 rounded-md flex items-center gap-3",
                        "hover:bg-[#E6EEF5]/60 transition-colors",
                      )}
                    >
                      <div
                        className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-semibold shrink-0"
                        style={{ backgroundColor: "#003366" }}
                      >
                        {primary.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate">
                          {primary}
                        </div>
                        {secondary && (
                          <div className="text-[11px] text-slate-500 truncate">
                            {secondary}
                          </div>
                        )}
                      </div>
                      <span className="material-symbols-outlined text-slate-400 text-[18px]">
                        chevron_right
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// Builds the subheader label the Builder shows ("Company · Project Name").
// Falls back gracefully when only one of the two fields is populated.
function buildBuilderLabel(d: Deal): string {
  const company = d.companyName || d.company?.name || "";
  const project = d.name || "";
  if (company && project && company !== project) return `${company} · ${project}`;
  return company || project || "Untitled deal";
}

function EmptyNoDeals() {
  return (
    <div className="py-10 flex flex-col items-center justify-center text-center">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <span className="material-symbols-outlined text-[24px]">folder_open</span>
      </div>
      <div className="text-sm font-medium text-slate-700">No deals yet</div>
      <div className="text-xs text-slate-500 max-w-xs mt-1 mb-4">
        Graphs need a deal to live under. Create one to get started.
      </div>
      <Link
        href="/deals"
        className="px-3.5 py-2 rounded-md text-sm font-medium text-white hover:opacity-90 inline-flex items-center gap-1.5"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        Create a deal first
      </Link>
    </div>
  );
}

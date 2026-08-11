"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/providers/ToastProvider";
import {
  Contact, ContactFormData, CONTACT_TYPES, TYPE_CONFIG,
  ContactModal, InsightCards,
} from "./components";
import { DetailPanel } from "./detail-panel";
import { FollowUpsBanner } from "./follow-ups-banner";
import { GmailSuggestions } from "./GmailSuggestions";
import { CSVImportModal } from "./csv-import-modal";
import { ContactCard, ContactRow, TABLE_HEADERS, TABLE_TH_CLS } from "./list-items";
import {
  CONTACTS_PAGE_SIZE, SORT_OPTIONS, groupContacts, sortGroupKeys,
  isStrengthSort, sortContactsByStrength,
} from "./list-utils";
import {
  ContactsGridSkeleton, ContactsTableSkeleton,
  ContactsErrorState, ContactsEmptyState,
} from "./loading-states";

// ─── Page Component ────────────────────────────────────────

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [totalContacts, setTotalContacts] = useState(0);
  const [contactScores, setContactScores] = useState<Record<string, { score: number; label: string }>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [filters, setFilters] = useState({ search: "", type: "", sortBy: "createdAt", sortOrder: "desc" });
  const [currentOffset, setCurrentOffset] = useState(0);

  // Modal / panel state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [groupByCompany, setGroupByCompany] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { showToast } = useToast();

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Refs for dropdown outside-click detection
  const typeButtonRef = useRef<HTMLButtonElement>(null);
  const typeDropdownRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  // ─── Data Loading ─────────────────────────────────────────

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.type) params.set("type", filters.type);
      // Strength is a client-side sort (not in the API's sortBy enum) — fall
      // back to a stable server order and reorder after load.
      params.set("sortBy", isStrengthSort(filters.sortBy) ? "createdAt" : filters.sortBy);
      params.set("sortOrder", filters.sortOrder);
      params.set("limit", String(CONTACTS_PAGE_SIZE));
      params.set("offset", "0");

      const [data, scores] = await Promise.all([
        api.get<{ contacts: Contact[]; total: number }>(`/contacts?${params}`),
        api.get<{ scores: Record<string, { score: number; label: string }> }>("/contacts/insights/scores").catch(() => ({ scores: {} })),
      ]);

      const fetched = data.contacts || [];
      setContacts(fetched);
      setTotalContacts(data.total || 0);
      setContactScores(scores.scores || {});
      setCurrentOffset(fetched.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  // Close dropdowns on outside click (ref-based, no stopPropagation needed)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Only close a dropdown if the click was NOT inside its button or menu
      if (
        !typeButtonRef.current?.contains(target) &&
        !typeDropdownRef.current?.contains(target)
      ) {
        setTypeOpen(false);
      }
      if (
        !sortButtonRef.current?.contains(target) &&
        !sortDropdownRef.current?.contains(target)
      ) {
        setSortOpen(false);
      }
      if (
        !moreButtonRef.current?.contains(target) &&
        !moreDropdownRef.current?.contains(target)
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (importModalOpen) { setImportModalOpen(false); return; }
        if (modalOpen) { setModalOpen(false); setEditingContact(null); return; }
        if (detailContactId) { setDetailContactId(null); return; }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [importModalOpen, modalOpen, detailContactId]);

  // ─── Load More ────────────────────────────────────────────

  async function handleLoadMore() {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.type) params.set("type", filters.type);
      // Strength is a client-side sort (not in the API's sortBy enum) — fall
      // back to a stable server order and reorder after load.
      params.set("sortBy", isStrengthSort(filters.sortBy) ? "createdAt" : filters.sortBy);
      params.set("sortOrder", filters.sortOrder);
      params.set("limit", String(CONTACTS_PAGE_SIZE));
      params.set("offset", String(currentOffset));

      const data = await api.get<{ contacts: Contact[]; total: number }>(`/contacts?${params}`);
      const newContacts = data.contacts || [];
      setContacts((prev) => [...prev, ...newContacts]);
      setCurrentOffset((prev) => prev + newContacts.length);
    } catch (err) {
      console.error("Error loading more:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  // ─── Handlers ─────────────────────────────────────────────

  function handleSearchChange(value: string) {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => setFilters((f) => ({ ...f, search: value })), 300);
  }

  function clearSearch() {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (searchInputRef.current) searchInputRef.current.value = "";
    setFilters((f) => ({ ...f, search: "" }));
  }

  function clearAllFilters() {
    clearSearch();
    setFilters((f) => ({ ...f, search: "", type: "" }));
  }

  const hasActiveFilters = !!(filters.search || filters.type);

  function openAddModal() { setEditingContact(null); setModalOpen(true); }

  async function handleSaveContact(formData: ContactFormData) {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...formData };
      // Remove empty optional fields
      Object.keys(body).forEach((k) => { if (body[k] === "" || body[k] === undefined) delete body[k]; });
      if (formData.tags.length > 0) body.tags = formData.tags; else delete body.tags;

      if (editingContact) await api.patch(`/contacts/${editingContact.id}`, body);
      else await api.post("/contacts", body);
      setModalOpen(false); setEditingContact(null); loadContacts();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save contact", "error");
    }
    finally { setSaving(false); }
  }

  async function handleExportCSV() {
    try {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      // Pass current filters to export (matches legacy behavior)
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.type) params.set("type", filters.type);
      // Strength is a client-side sort (not in the API's sortBy enum) — fall
      // back to a stable server order and reorder after load.
      params.set("sortBy", isStrengthSort(filters.sortBy) ? "createdAt" : filters.sortBy);
      params.set("sortOrder", filters.sortOrder);
      const res = await fetch(`/api/contacts/export?${params}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `contacts-export-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[contacts] CSV export failed:", err);
      showToast("Failed to export contacts", "error");
    }
  }

  const currentSortLabel = SORT_OPTIONS.find((o) => o.sortBy === filters.sortBy && o.sortOrder === filters.sortOrder)?.label || "Newest First";

  // ─── Group by Company derived state ───────────────────────

  const displayContacts = isStrengthSort(filters.sortBy)
    ? sortContactsByStrength(contacts, contactScores, filters.sortOrder as "asc" | "desc")
    : contacts;
  const grouped = groupByCompany ? groupContacts(displayContacts) : {};
  const sortedGroupKeys = groupByCompany ? sortGroupKeys(grouped) : [];
  const hasMore = contacts.length < totalContacts;
  const remaining = totalContacts - contacts.length;

  // ─── Render helpers ───────────────────────────────────────

  const tableHead = (
    <thead>
      <tr className="border-b border-border-subtle bg-slate-50/50">
        {TABLE_HEADERS.map((h) => <th key={h} className={TABLE_TH_CLS}>{h}</th>)}
      </tr>
    </thead>
  );

  const renderCard = (contact: Contact) => (
    <ContactCard key={contact.id} contact={contact} contactScores={contactScores} onClick={() => setDetailContactId(contact.id)} />
  );

  const renderRow = (contact: Contact) => (
    <ContactRow key={contact.id} contact={contact} contactScores={contactScores} onClick={() => setDetailContactId(contact.id)} />
  );

  return (
    <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">Contacts</h1>
            {!loading && <span className="px-2.5 py-0.5 rounded-full bg-primary-light text-primary text-xs font-bold">{totalContacts}</span>}
          </div>
          <p className="text-text-secondary text-sm flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(5,150,105,0.4)]" />
            {loading ? "Loading contacts..." : `${totalContacts} contact${totalContacts !== 1 ? "s" : ""} in your network`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <span className="material-symbols-outlined text-text-muted group-focus-within:text-primary transition-colors text-[18px]">search</span>
            </div>
            <input ref={searchInputRef} type="text" defaultValue={filters.search} onChange={(e) => handleSearchChange(e.target.value)}
              className="block w-64 rounded-lg border border-border-subtle bg-surface-card py-2 pl-10 pr-9 text-sm text-text-main placeholder-text-muted focus:ring-1 focus:ring-primary focus:border-primary transition-all shadow-sm" placeholder="Search name, company, email..." />
            {filters.search && (
              <button onClick={clearSearch} className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-secondary transition-colors" title="Clear search" aria-label="Clear search">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>

          {/* Type Filter */}
          <div className="relative">
            <button ref={typeButtonRef} onClick={() => { setTypeOpen((v) => !v); setSortOpen(false); setMoreOpen(false); }}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-surface-card border border-border-subtle px-3.5 hover:border-primary/30 hover:shadow-sm transition-all group text-sm font-medium text-text-secondary">
              {filters.type ? TYPE_CONFIG[filters.type]?.label : "All Types"}
              <span className="material-symbols-outlined text-text-muted text-[16px]">keyboard_arrow_down</span>
            </button>
            {typeOpen && (
              <div ref={typeDropdownRef} className="absolute top-full left-0 mt-2 bg-surface-card border border-border-subtle rounded-lg shadow-lg z-50 min-w-[160px] py-1">
                <button onClick={() => { setFilters((f) => ({ ...f, type: "" })); setTypeOpen(false); }} className={cn("w-full text-left px-4 py-2 text-sm hover:bg-primary-light", !filters.type && "font-medium")}>All Types</button>
                {CONTACT_TYPES.map((t) => (
                  <button key={t} onClick={() => { setFilters((f) => ({ ...f, type: t })); setTypeOpen(false); }} className={cn("w-full text-left px-4 py-2 text-sm hover:bg-primary-light", filters.type === t && "font-medium text-primary")}>{TYPE_CONFIG[t].label}</button>
                ))}
              </div>
            )}
          </div>

          {/* Sort */}
          <div className="relative">
            <button ref={sortButtonRef} onClick={() => { setSortOpen((v) => !v); setTypeOpen(false); setMoreOpen(false); }}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-surface-card border border-border-subtle px-3.5 hover:border-primary/30 hover:shadow-sm transition-all group text-sm font-medium text-text-secondary">
              <span className="material-symbols-outlined text-text-muted text-[16px]">swap_vert</span>
              <span className="whitespace-nowrap">{currentSortLabel}</span>
              <span className="material-symbols-outlined text-text-muted text-[16px]">keyboard_arrow_down</span>
            </button>
            {sortOpen && (
              <div ref={sortDropdownRef} className="absolute top-full left-0 mt-2 bg-surface-card border border-border-subtle rounded-lg shadow-lg z-50 min-w-[200px] py-1">
                <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider">Sort by</div>
                {SORT_OPTIONS.map((opt) => (
                  <button key={`${opt.sortBy}-${opt.sortOrder}`} onClick={() => { setFilters((f) => ({ ...f, sortBy: opt.sortBy, sortOrder: opt.sortOrder })); setSortOpen(false); }}
                    className={cn("w-full text-left px-4 py-2 text-sm hover:bg-primary-light flex items-center justify-between", filters.sortBy === opt.sortBy && filters.sortOrder === opt.sortOrder && "font-medium text-primary")}>
                    {opt.label}
                    {filters.sortBy === opt.sortBy && filters.sortOrder === opt.sortOrder && <span className="material-symbols-outlined text-primary text-[16px]">check</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* View Toggle */}
          <div className="flex h-9 rounded-lg border border-border-subtle overflow-hidden">
            <button onClick={() => setViewMode("grid")} className={cn("flex items-center justify-center w-9 h-full transition-colors", viewMode === "grid" ? "bg-primary/10 text-primary" : "bg-surface-card text-text-muted hover:text-text-secondary")} title="Grid view">
              <span className="material-symbols-outlined text-[18px]">grid_view</span>
            </button>
            <button onClick={() => setViewMode("list")} className={cn("flex items-center justify-center w-9 h-full transition-colors", viewMode === "list" ? "bg-primary/10 text-primary" : "bg-surface-card text-text-muted hover:text-text-secondary")} title="List view">
              <span className="material-symbols-outlined text-[18px]">view_list</span>
            </button>
          </div>

          {/* More Actions */}
          <div className="relative">
            <button ref={moreButtonRef} onClick={() => { setMoreOpen((v) => !v); setTypeOpen(false); setSortOpen(false); }}
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-surface-card border border-border-subtle px-3.5 hover:border-primary/30 hover:shadow-sm transition-all group text-sm font-medium text-text-secondary">
              <span className="material-symbols-outlined text-text-muted text-[16px]">more_horiz</span>
              <span className="group-hover:text-text-main">More</span>
              <span className="material-symbols-outlined text-text-muted text-[16px]">keyboard_arrow_down</span>
            </button>
            {moreOpen && (
              <div ref={moreDropdownRef} className="absolute top-full right-0 mt-2 bg-surface-card border border-border-subtle rounded-lg shadow-lg z-50 min-w-[200px] py-1">
                <button onClick={() => { setGroupByCompany(!groupByCompany); setMoreOpen(false); }} className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-text-secondary hover:bg-primary-light hover:text-text-main transition-colors">
                  <span className="material-symbols-outlined text-[18px]">corporate_fare</span>{groupByCompany ? "Ungroup Contacts" : "Group by Company"}
                </button>
                <button onClick={() => { handleExportCSV(); setMoreOpen(false); }} className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-text-secondary hover:bg-primary-light hover:text-text-main transition-colors">
                  <span className="material-symbols-outlined text-[18px]">download</span>Export to CSV
                </button>
                <button onClick={() => { setImportModalOpen(true); setMoreOpen(false); }} className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-text-secondary hover:bg-primary-light hover:text-text-main transition-colors">
                  <span className="material-symbols-outlined text-[18px]">upload_file</span>Import from CSV
                </button>
              </div>
            )}
          </div>

          {/* Add Contact */}
          <button onClick={openAddModal} className="flex items-center gap-2 px-4 py-2 text-white rounded-lg shadow-sm hover:bg-[#002855] transition-colors text-sm font-medium" style={{ backgroundColor: "#003366" }}>
            <span className="material-symbols-outlined text-[18px]">person_add</span>Add Contact
          </button>
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="flex items-center gap-2 flex-wrap -mt-2">
          <span className="text-xs font-medium text-text-muted">Filters:</span>
          {filters.search && (
            <button onClick={clearSearch} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-light text-primary text-xs font-medium hover:opacity-80 transition-opacity">
              <span className="material-symbols-outlined text-[14px]">search</span>
              &ldquo;{filters.search}&rdquo;
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          )}
          {filters.type && (
            <button onClick={() => setFilters((f) => ({ ...f, type: "" }))} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-light text-primary text-xs font-medium hover:opacity-80 transition-opacity">
              {TYPE_CONFIG[filters.type]?.label || filters.type}
              <span className="material-symbols-outlined text-[14px]">close</span>
            </button>
          )}
          <button onClick={clearAllFilters} className="text-xs font-medium text-text-muted hover:text-text-secondary transition-colors underline">
            Clear all
          </button>
        </div>
      )}

      {/* Follow-ups due banner — calls GET /contacts/insights/follow-ups */}
      {!loading && <FollowUpsBanner onOpenContact={setDetailContactId} />}

      {/* Add contacts from your inbox — lazy, non-blocking Gmail suggestions */}
      {!loading && <GmailSuggestions onContactAdded={loadContacts} />}

      {/* Insight Cards — "Needs attention" stale contacts */}
      {!loading && <InsightCards totalContacts={totalContacts} onOpenContact={setDetailContactId} />}

      {/* Content */}
      {loading ? (
        viewMode === "grid" ? <ContactsGridSkeleton /> : <ContactsTableSkeleton />
      ) : error ? (
        <ContactsErrorState error={error} onRetry={loadContacts} />
      ) : contacts.length === 0 ? (
        <ContactsEmptyState filtered={hasActiveFilters} onAdd={openAddModal} />
      ) : groupByCompany ? (
        <div className="flex flex-col gap-5">
          {sortedGroupKeys.map((company) => (
            <div key={company}>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-text-muted text-[18px]">corporate_fare</span>
                  <h3 className="text-sm font-bold text-text-main">{company}</h3>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-text-muted text-[11px] font-bold">{grouped[company].length}</span>
                <div className="flex-1 border-t border-border-subtle" />
              </div>
              {viewMode === "grid" ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">{grouped[company].map(renderCard)}</div>
              ) : (
                <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card overflow-hidden overflow-x-auto">
                  <table className="w-full min-w-[600px]">{tableHead}<tbody>{grouped[company].map(renderRow)}</tbody></table>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">{displayContacts.map(renderCard)}</div>
      ) : (
        <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[600px]">{tableHead}<tbody>{displayContacts.map(renderRow)}</tbody></table>
        </div>
      )}

      {/* Pagination Bar */}
      {!loading && totalContacts > 0 && (
        <div className="flex items-center justify-between py-4 pb-6">
          <p className="text-sm text-text-muted font-medium">
            Showing {Math.min(contacts.length, totalContacts)} of {totalContacts} contact{totalContacts !== 1 ? "s" : ""}
          </p>
          {hasMore && (
            <button onClick={handleLoadMore} disabled={loadingMore}
              className="flex items-center gap-2 px-5 py-2 rounded-lg border border-border-subtle bg-surface-card text-sm font-medium text-text-secondary hover:border-primary/30 hover:text-primary hover:shadow-sm transition-all disabled:opacity-50">
              {loadingMore ? (
                <><span className="material-symbols-outlined text-[18px] animate-spin">sync</span>Loading...</>
              ) : (
                <><span className="material-symbols-outlined text-[18px]">expand_more</span>Load More ({remaining} remaining)</>
              )}
            </button>
          )}
        </div>
      )}

      {/* Modals & Panels */}
      {modalOpen && <ContactModal contact={editingContact} saving={saving} onSave={handleSaveContact} onClose={() => { setModalOpen(false); setEditingContact(null); }} />}
      {detailContactId && <DetailPanel contactId={detailContactId} contactScores={contactScores} onClose={() => setDetailContactId(null)} onRefresh={loadContacts} />}
      {importModalOpen && <CSVImportModal onClose={() => setImportModalOpen(false)} onDone={loadContacts} />}
    </div>
  );
}

"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { useApiQuery } from "@/lib/useApiQuery";
import { formatRelativeTime } from "@/lib/formatters";
import { STAGE_LABELS } from "@/lib/constants";
import {
  CompanyListItem, CompanyListResponse, CompanySort, HasDealsFilter, SourceFilter,
  COMPANIES_PAGE_SIZE, HAS_DEALS_OPTIONS, SOURCE_OPTIONS, SORT_OPTIONS,
  buildCompaniesQuery, websiteHref, websiteLabel,
} from "./companies-shared";
import { CompanyDrawer, SourceBadge } from "./company-drawer";

// ─── /companies ─────────────────────────────────────────────
// Every company in the org — including HubSpot imports with no deal yet,
// which were otherwise only visible through deals and contacts.
// Server-side search / filters / paging via GET /api/companies/list.

const TH_CLS = "px-4 py-3 text-left text-[11px] font-bold text-text-muted uppercase tracking-wider";
const HEADERS = ["Company", "Industry", "Website", "Deals", "Contacts", "Source", "Updated"];
const SELECT_CLS =
  "h-9 rounded-lg bg-surface-card border border-border-subtle px-3 text-sm font-medium text-text-secondary hover:border-primary/30 focus:ring-1 focus:ring-primary focus:border-primary transition-all";

function DealsCell({
  company, expanded, onToggle,
}: { company: CompanyListItem; expanded: boolean; onToggle: () => void }) {
  if (company.dealCount === 0) return <span className="text-text-muted text-sm">0</span>;
  if (company.dealCount === 1) {
    const deal = company.deals[0];
    return (
      <Link
        href={`/deals/${deal.id}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline max-w-[180px]"
        title={deal.name ?? undefined}
      >
        <span className="material-symbols-outlined text-[14px]">work</span>
        <span className="truncate">{deal.name || "1 deal"}</span>
      </Link>
    );
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-expanded={expanded}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
    >
      <span className="material-symbols-outlined text-[14px]">work</span>
      {company.dealCount} deals
      <span className="material-symbols-outlined text-[16px]">{expanded ? "expand_less" : "expand_more"}</span>
    </button>
  );
}

function TableSkeleton() {
  return (
    <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card overflow-hidden" data-testid="companies-loading">
      <div className="flex flex-col divide-y divide-border-subtle">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-4 flex gap-6 animate-pulse">
            <div className="h-3 w-1/4 rounded bg-slate-100" />
            <div className="h-3 w-1/6 rounded bg-slate-100" />
            <div className="h-3 w-1/6 rounded bg-slate-100" />
            <div className="h-3 w-12 rounded bg-slate-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CompaniesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [hasDeals, setHasDeals] = useState<HasDealsFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<CompanySort>("name-asc");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openCompanyId, setOpenCompanyId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryKey = useMemo(
    () => buildCompaniesQuery({ search, hasDeals, source, sort, page }),
    [search, hasDeals, source, sort, page],
  );
  const { data, error, isLoading, refetch } = useApiQuery<CompanyListResponse>(queryKey);

  const companies = data?.companies ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / COMPANIES_PAGE_SIZE));
  const hasActiveFilters = !!search || hasDeals !== "all" || source !== "all";

  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  useEffect(() => {
    if (!openCompanyId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenCompanyId(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openCompanyId]);

  const onSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setSearch(value.trim()); setPage(0); }, 300);
  };

  const clearAll = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearchInput(""); setSearch(""); setHasDeals("all"); setSource("all"); setPage(0);
  };

  const firstShown = total === 0 ? 0 : page * COMPANIES_PAGE_SIZE + 1;
  const lastShown = page * COMPANIES_PAGE_SIZE + companies.length;

  return (
    <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">Companies</h1>
            {data && <span className="px-2.5 py-0.5 rounded-full bg-primary-light text-primary text-xs font-bold">{total}</span>}
          </div>
          <p className="text-text-secondary text-sm">
            Every company in your workspace — from deals, contacts and HubSpot imports.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <span className="material-symbols-outlined text-text-muted group-focus-within:text-primary transition-colors text-[18px]">search</span>
            </div>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search companies"
              placeholder="Search companies..."
              className="block w-64 rounded-lg border border-border-subtle bg-surface-card py-2 pl-10 pr-9 text-sm text-text-main placeholder-text-muted focus:ring-1 focus:ring-primary focus:border-primary transition-all shadow-sm"
            />
            {searchInput && (
              <button onClick={() => { if (searchTimer.current) clearTimeout(searchTimer.current); setSearchInput(""); setSearch(""); setPage(0); }}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-secondary" aria-label="Clear search">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
          <select aria-label="Filter by deals" value={hasDeals} className={SELECT_CLS}
            onChange={(e) => { setHasDeals(e.target.value as HasDealsFilter); setPage(0); }}>
            {HAS_DEALS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select aria-label="Filter by source" value={source} className={SELECT_CLS}
            onChange={(e) => { setSource(e.target.value as SourceFilter); setPage(0); }}>
            {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select aria-label="Sort companies" value={sort} className={SELECT_CLS}
            onChange={(e) => { setSort(e.target.value as CompanySort); setPage(0); }}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <TableSkeleton />
      ) : error && !data ? (
        <div className="flex flex-col items-center justify-center py-20">
          <span className="material-symbols-outlined text-red-500 text-4xl mb-4">error</span>
          <p className="text-text-main font-medium mb-2">Failed to load companies</p>
          <p className="text-text-muted text-sm mb-4">{error.message}</p>
          <button onClick={() => refetch()} className="px-4 py-2 text-white rounded-lg text-sm font-medium hover:opacity-90" style={{ backgroundColor: "#003366" }}>Try Again</button>
        </div>
      ) : companies.length === 0 ? (
        hasActiveFilters ? (
          <div className="flex flex-col items-center justify-center py-20">
            <span className="material-symbols-outlined text-text-muted text-4xl mb-4">search_off</span>
            <p className="text-text-main font-medium mb-2">No companies found</p>
            <p className="text-text-muted text-sm mb-4">Try adjusting your search or filters</p>
            <button onClick={clearAll} className="text-sm font-medium text-primary hover:underline">Clear filters</button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="size-16 rounded-full bg-blue-50/60 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[#003366] text-3xl">corporate_fare</span>
            </div>
            <h3 className="text-base font-bold text-text-main mb-2">No companies yet</h3>
            <p className="text-text-muted text-sm mb-5 text-center max-w-sm">
              Companies appear here when you add a deal or import from HubSpot in Settings.
            </p>
            <div className="flex items-center gap-3">
              <Link href="/deals" className="px-4 py-2 text-white rounded-lg shadow-sm text-sm font-medium hover:opacity-90" style={{ backgroundColor: "#003366" }}>Go to Deals</Link>
              <Link href="/settings" className="px-4 py-2 rounded-lg border border-border-subtle text-sm font-medium text-text-secondary hover:border-primary/30">Import from HubSpot</Link>
            </div>
          </div>
        )
      ) : (
        <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card overflow-hidden overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="border-b border-border-subtle bg-slate-50/50">
                {HEADERS.map((h) => <th key={h} className={TH_CLS}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const href = websiteHref(c.website);
                const expanded = expandedId === c.id;
                return (
                  <Fragment key={c.id}>
                    <tr onClick={() => setOpenCompanyId(c.id)} className="hover:bg-slate-50/80 cursor-pointer transition-colors border-b border-border-subtle">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="size-8 rounded-lg bg-primary-light text-primary flex items-center justify-center shrink-0">
                            <span className="material-symbols-outlined text-[18px]">corporate_fare</span>
                          </div>
                          <span className="text-sm font-semibold text-text-main truncate max-w-[260px]">{c.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary truncate max-w-[180px]">{c.industry || "--"}</td>
                      <td className="px-4 py-3 text-sm truncate max-w-[180px]">
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">
                            {websiteLabel(c.website)}
                          </a>
                        ) : <span className="text-text-muted">--</span>}
                      </td>
                      <td className="px-4 py-3">
                        <DealsCell company={c} expanded={expanded} onToggle={() => setExpandedId(expanded ? null : c.id)} />
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{c.contactCount}</td>
                      <td className="px-4 py-3"><SourceBadge source={c.source} /></td>
                      <td className="px-4 py-3 text-sm text-text-muted whitespace-nowrap">{c.updatedAt ? formatRelativeTime(c.updatedAt) : "--"}</td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border-subtle bg-slate-50/40">
                        <td colSpan={HEADERS.length} className="px-4 py-2 pl-[60px]">
                          <ul className="flex flex-col gap-1">
                            {c.deals.map((d) => (
                              <li key={d.id} className="flex items-center gap-3 text-sm">
                                <Link href={`/deals/${d.id}`} className="text-primary hover:underline">{d.name || "Untitled deal"}</Link>
                                {d.stage && <span className="text-[11px] text-text-muted">{STAGE_LABELS[d.stage] ?? d.stage}</span>}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && total > 0 && (
        <div className="flex items-center justify-between py-2 pb-6">
          <p className="text-sm text-text-muted font-medium">
            Showing {firstShown}–{lastShown} of {total} compan{total === 1 ? "y" : "ies"}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page"
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-card text-sm font-medium text-text-secondary hover:border-primary/30 hover:text-primary disabled:opacity-50 disabled:pointer-events-none">
              <span className="material-symbols-outlined text-[18px]">chevron_left</span>Prev
            </button>
            <span className="text-sm text-text-muted">Page {page + 1} of {pageCount}</span>
            <button onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1} aria-label="Next page"
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-card text-sm font-medium text-text-secondary hover:border-primary/30 hover:text-primary disabled:opacity-50 disabled:pointer-events-none">
              Next<span className="material-symbols-outlined text-[18px]">chevron_right</span>
            </button>
          </div>
        </div>
      )}

      {openCompanyId && <CompanyDrawer companyId={openCompanyId} onClose={() => setOpenCompanyId(null)} />}
    </div>
  );
}

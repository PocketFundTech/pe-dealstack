"use client";

// ---------------------------------------------------------------------------
// CommandPalette — Cmd+K spotlight overlay for quick navigation.
// Ported from commandPalette.js. The legacy palette listed Pages,
// Deals, and Contacts — the web-next port restructures into Pages, Recent
// Deals, and Actions (broader navigation). Per-result search continues to use
// case-insensitive AND-of-words substring match across label + keywords.
//
// This component is mounted once at the (app) layout root so the keyboard
// listener and modal portal are available across every authenticated page.
// ---------------------------------------------------------------------------

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { api, NotFoundError } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";
import { useIngestDealModal } from "@/providers/IngestDealModalProvider";
import type { Deal } from "@/types";
import {
  ACTION_OPEN_DEAL_INTAKE,
  ContactRow,
  GROUP_LABELS,
  GROUP_ORDER,
  PALETTE_ACTIONS,
  PaletteResult,
} from "./CommandPalette.types";
import {
  buildActions,
  buildPages,
  buildResults,
} from "./CommandPalette.results";
import { PaletteItem } from "./CommandPalette.item";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette() {
  const router = useRouter();
  const { user } = useUser();
  const { openDealIntake } = useIngestDealModal();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentDeals, setRecentDeals] = useState<Deal[]>([]);
  const [allDeals, setAllDeals] = useState<Deal[]>([]);
  const [allContacts, setAllContacts] = useState<ContactRow[]>([]);
  const recentDealsFetchedRef = useRef(false);
  const allDealsFetchedRef = useRef(false);
  const allContactsFetchedRef = useRef(false);

  // -----------------------------------------------------------------------
  // Visibility filters — match Sidebar role gating exactly.
  // -----------------------------------------------------------------------
  const isAdmin = user?.systemRole === "ADMIN";
  const isMember = user?.systemRole === "ADMIN" || user?.systemRole === "MEMBER";

  // -----------------------------------------------------------------------
  // Pages + Actions, derived from role.
  // -----------------------------------------------------------------------
  const pages = useMemo<PaletteResult[]>(
    () => buildPages({ isAdmin, isMember }),
    [isAdmin, isMember],
  );
  const actions = useMemo<PaletteResult[]>(
    () => buildActions(PALETTE_ACTIONS, isMember),
    [isMember],
  );

  // -----------------------------------------------------------------------
  // Recent deals — 5-item preview shown on empty query (fetched once on
  // first open). Falls back silently on any error (matches legacy).
  // -----------------------------------------------------------------------
  const fetchRecentDeals = useCallback(async () => {
    if (recentDealsFetchedRef.current) return;
    recentDealsFetchedRef.current = true;
    try {
      const data = await api.get<Deal[] | { deals: Deal[] }>(
        "/deals?sortBy=updatedAt&sortOrder=desc&limit=5",
      );
      const list = Array.isArray(data) ? data : (data?.deals ?? []);
      setRecentDeals(list.slice(0, 5));
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        console.warn("[CommandPalette] recent /deals fetch failed:", err);
      }
    }
  }, []);

  // -----------------------------------------------------------------------
  // Full deals list — fetched once when the user starts typing. Mirrors
  // legacy commandPalette.js dealsCache.
  // -----------------------------------------------------------------------
  const fetchAllDeals = useCallback(async () => {
    if (allDealsFetchedRef.current) return;
    allDealsFetchedRef.current = true;
    try {
      const data = await api.get<Deal[] | { deals: Deal[] }>("/deals");
      const list = Array.isArray(data) ? data : (data?.deals ?? []);
      setAllDeals(list);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        console.warn("[CommandPalette] /deals fetch failed:", err);
      }
    }
  }, []);

  // -----------------------------------------------------------------------
  // Full contacts list — fetched once on first input. Mirrors legacy
  // commandPalette.js contactsCache.
  // -----------------------------------------------------------------------
  const fetchAllContacts = useCallback(async () => {
    if (allContactsFetchedRef.current) return;
    allContactsFetchedRef.current = true;
    try {
      const data = await api.get<ContactRow[] | { contacts: ContactRow[] }>("/contacts");
      const list = Array.isArray(data) ? data : (data?.contacts ?? []);
      setAllContacts(list);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        console.warn("[CommandPalette] /contacts fetch failed:", err);
      }
    }
  }, []);

  // Trigger lazy fetches once the user starts typing.
  useEffect(() => {
    if (query.trim().length === 0) return;
    fetchAllDeals();
    fetchAllContacts();
  }, [query, fetchAllDeals, fetchAllContacts]);

  // -----------------------------------------------------------------------
  // Combined results — cap, filter, build the visible list.
  // -----------------------------------------------------------------------
  const results = useMemo<PaletteResult[]>(
    () => buildResults({ query, pages, actions, recentDeals, allDeals, allContacts }),
    [pages, actions, query, recentDeals, allDeals, allContacts],
  );

  // -----------------------------------------------------------------------
  // Open / close helpers — the modal's open state is tracked here so the
  // global keydown listener can toggle without re-attaching.
  // -----------------------------------------------------------------------
  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  // -----------------------------------------------------------------------
  // Global Cmd/Ctrl+K + Escape listener. Also listens for an
  // "open-command-palette" window event so the Header search bar (and any
  // other UI affordance) can open the palette programmatically without a
  // competing keyboard handler.
  // -----------------------------------------------------------------------
  useEffect(() => {
    function open() {
      setOpen((prev) => {
        if (prev) return prev;
        setQuery("");
        setActiveIndex(0);
        fetchRecentDeals();
        return true;
      });
    }
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => {
          if (prev) return false;
          setQuery("");
          setActiveIndex(0);
          fetchRecentDeals();
          return true;
        });
      } else if (e.key === "Escape") {
        setOpen((prev) => (prev ? false : prev));
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("open-command-palette", open);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("open-command-palette", open);
    };
  }, [fetchRecentDeals]);

  // -----------------------------------------------------------------------
  // Focus the input shortly after the modal mounts (matches legacy 50ms
  // delay using requestAnimationFrame so the portal has rendered first).
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // -----------------------------------------------------------------------
  // Reset the active index whenever the visible results change so we don't
  // point past the end of the list.
  // -----------------------------------------------------------------------
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // -----------------------------------------------------------------------
  // Scroll active item into view as user navigates with arrow keys.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!resultsRef.current) return;
    const items = resultsRef.current.querySelectorAll("[data-palette-item]");
    const el = items[activeIndex];
    if (el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  // -----------------------------------------------------------------------
  // Selection — close, then route via Next.js router (no full page nav).
  // -----------------------------------------------------------------------
  const selectResult = useCallback(
    (result: PaletteResult) => {
      closePalette();
      // Intercept the deal-intake action so it opens the modal instead of
      // navigating to the standalone /deal-intake route.
      if (result.kind === "action" && result.href === ACTION_OPEN_DEAL_INTAKE) {
        openDealIntake();
        return;
      }
      router.push(result.href);
    },
    [closePalette, router, openDealIntake],
  );

  // -----------------------------------------------------------------------
  // Per-input keyboard handling (arrows + Enter). Escape is handled on the
  // global capture-phase listener above.
  // -----------------------------------------------------------------------
  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, Math.max(results.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const result = results[activeIndex];
        if (result) selectResult(result);
      }
    },
    [results, activeIndex, selectResult],
  );

  if (!open) return null;
  if (typeof document === "undefined") return null;

  // -----------------------------------------------------------------------
  // Group results for rendering. Maintain a global index counter so the
  // arrow-key activeIndex maps cleanly across visible groups.
  // -----------------------------------------------------------------------
  const grouped: Record<PaletteResult["kind"], PaletteResult[]> = {
    page: [],
    deal: [],
    contact: [],
    action: [],
  };
  for (const r of results) grouped[r.kind].push(r);

  // When showing the empty-query preview, label the deals group
  // "Recent Deals" instead of "Deals".
  const dealGroupLabel = query.trim() ? "Deals" : "Recent Deals";

  let globalIdx = 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[18vh]"
      data-modal-overlay
      style={{ backgroundColor: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
        style={{ boxShadow: "0 25px 60px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05)" }}
      >
        {/* Search input ------------------------------------------------ */}
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-gray-200">
          <span className="material-symbols-outlined text-gray-400" style={{ fontSize: 22 }}>
            search
          </span>
          <input
            ref={inputRef}
            type="text"
            className="flex-1 text-[15px] bg-transparent font-sans text-gray-900 placeholder-gray-400"
            style={{ outline: "none", border: "none" }}
            placeholder="Jump to a page, deal, or action..."
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 bg-gray-100 rounded border border-gray-200 font-sans">
            ESC
          </kbd>
        </div>

        {/* Results ----------------------------------------------------- */}
        <div ref={resultsRef} className="max-h-[340px] overflow-y-auto p-1.5 custom-scrollbar">
          {results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <span
                className="material-symbols-outlined mb-1"
                style={{ fontSize: 28, opacity: 0.4 }}
              >
                search_off
              </span>
              <p className="text-[13px]">No results found</p>
            </div>
          ) : (
            GROUP_ORDER.map((kind) => {
              const items = grouped[kind];
              if (items.length === 0) return null;
              return (
                <div key={kind}>
                  <div className="px-2.5 pt-2 pb-1 text-[10px] font-bold text-gray-400 uppercase tracking-[0.06em]">
                    {kind === "deal" ? dealGroupLabel : GROUP_LABELS[kind]}
                  </div>
                  {items.map((item) => {
                    const idx = globalIdx++;
                    const isActive = idx === activeIndex;
                    const itemKey =
                      item.kind === "deal" || item.kind === "page" || item.kind === "contact"
                        ? `${item.kind}:${item.id}`
                        : `action:${item.href}`;
                    return (
                      <PaletteItem
                        key={itemKey}
                        item={item}
                        isActive={isActive}
                        onClick={() => selectResult(item)}
                        onMouseEnter={() => setActiveIndex(idx)}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        {/* Footer ------------------------------------------------------ */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 text-[11px] text-gray-400">
          <span>
            <kbd className="inline-block text-[10px] font-semibold bg-gray-100 border border-gray-200 rounded px-1 py-px font-sans mx-0.5">
              &uarr;&darr;
            </kbd>
            {" "}Navigate
            {" "}&#xB7;{" "}
            <kbd className="inline-block text-[10px] font-semibold bg-gray-100 border border-gray-200 rounded px-1 py-px font-sans mx-0.5">
              &#x21B5;
            </kbd>
            {" "}Open
          </span>
          <span className="text-gray-400">Avise Command Palette</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

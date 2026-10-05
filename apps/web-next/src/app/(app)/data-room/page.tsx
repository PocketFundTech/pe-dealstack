"use client";

// Data Room index — "room cards". Every room shows how complete it is
// (folder coverage + document count), its latest upload, and any open
// document requests or live share links. Stats load per room, visible-first.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import { SideSheet } from "@/components/dash/side-sheet";
import { UndoBar, useUndoBar } from "@/components/dash/undo-bar";
import { useNow } from "../dashboard/use-now";
import { RoomCard } from "./room-card";
import { useRoomStats } from "./use-room-stats";
import {
  duplicateNames, inTab, isPassed, matchesSearch, roomStatus, sortRooms,
  type RoomDeal, type RoomSort, type RoomStatus, type RoomTab,
} from "./room-status";
import "@/components/dash/dash.css";

const TABS: { value: RoomTab; label: string }[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "ATTENTION", label: "Needs attention" },
  { value: "PASSED", label: "Passed" },
  { value: "ALL", label: "All" },
];
const SORTS: { value: RoomSort; label: string }[] = [
  { value: "UPLOAD", label: "Latest upload" },
  { value: "COVERAGE", label: "Coverage" },
  { value: "NAME", label: "Name" },
];

export default function DataRoomOverviewPage() {
  const router = useRouter();
  const now = useNow();
  const undo = useUndoBar();
  const [deals, setDeals] = useState<RoomDeal[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tab, setTab] = useState<RoomTab>("ACTIVE");
  const [sort, setSort] = useState<RoomSort>("UPLOAD");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const load = async () => {
    setLoadError(false);
    try {
      const data = await api.get<RoomDeal[] | { deals: RoomDeal[] }>("/deals?limit=200");
      setDeals(Array.isArray(data) ? data : data.deals || []);
    } catch (err) {
      console.warn("[data-room] failed to load deals:", err);
      setLoadError(true);
      setDeals([]);
    }
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
  useEffect(() => { load(); }, []);

  // Stats: fetch in on-screen order (current tab + sort first, then the rest).
  const all = useMemo(() => deals ?? [], [deals]);
  const firstPass = useMemo(() => sortRooms(all.filter((d) => !isPassed(d)), "UPLOAD", new Map()), [all]);
  const order = useMemo(() => [...firstPass, ...all.filter(isPassed)].map((d) => d.id), [firstPass, all]);
  const { stats, failed, retry } = useRoomStats(order);

  const statuses = useMemo(() => {
    const m = new Map<string, RoomStatus>();
    for (const d of all) {
      const s = stats.get(d.id);
      if (s) m.set(d.id, roomStatus(d, s, now));
    }
    return m;
  }, [all, stats, now]);

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.value, all.filter((d) => inTab(d, t.value, statuses.get(d.id))).length])) as Record<RoomTab, number>, [all, statuses]);
  const visible = sortRooms(all.filter((d) => inTab(d, tab, statuses.get(d.id)) && matchesSearch(d, query)), sort, statuses);
  const dupes = useMemo(() => duplicateNames(all), [all]);

  const active = all.filter((d) => !isPassed(d));
  const loaded = active.filter((d) => statuses.has(d.id));
  const totals = loaded.reduce(
    (t, d) => {
      const s = statuses.get(d.id)!;
      return { docs: t.docs + s.documents, requests: t.requests + s.openRequests.length, shares: t.shares + s.liveShares.length };
    },
    { docs: 0, requests: 0, shares: 0 },
  );
  const stillLoading = loaded.length < active.length;
  const today = new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <div className="dash px-4 py-6 md:px-8 md:py-9 lg:px-10">
      <div className="dash-reveal mx-auto flex w-full max-w-[1480px] flex-col gap-7">
        {/* Masthead */}
        <header className="relative z-20 flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
            <div className="min-w-0">
              <p className="dash-label">{today}</p>
              <h1 className="dash-display mt-2 text-[1.75rem] leading-[1.1] text-(--dash-ink) md:text-[2.125rem]">Data Rooms</h1>
              <p className="dash-num mt-2 min-h-6 text-[0.9375rem] text-(--dash-ink-2)">
                {deals === null ? (
                  <span className="inline-block h-4 w-72 animate-pulse rounded bg-(--dash-wash) align-middle" />
                ) : (
                  <>
                    <span className="font-semibold text-(--dash-ink)">{active.length} active {active.length === 1 ? "room" : "rooms"}</span>
                    {" · "}{totals.docs}{stillLoading ? "+" : ""} documents
                    {" · "}{totals.requests} open {totals.requests === 1 ? "request" : "requests"}
                    {" · "}{totals.shares} live share {totals.shares === 1 ? "link" : "links"}
                    {stillLoading && <span className="text-(--dash-ink-3)"> · counting…</span>}
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="dash-btn-primary flex items-center gap-1.5 rounded-md py-2 pl-3 pr-4 text-sm font-semibold"
            >
              <span aria-hidden className="material-symbols-outlined text-[18px]">add</span>
              New room
            </button>
          </div>
          <div className="dash-double-rule" />
        </header>

        {/* Toolbar */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-(--dash-rule)">
          <div role="tablist" aria-label="Filter rooms" className="no-scrollbar -mb-px flex max-w-full gap-x-5 overflow-x-auto">
            {TABS.map((t) => {
              const selected = tab === t.value;
              const n = counts[t.value] ?? 0;
              return (
                <button
                  key={t.value}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  onClick={() => setTab(t.value)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 pb-3 text-sm font-medium transition-colors",
                    selected ? "border-(--dash-blue) text-(--dash-ink)" : "border-transparent text-(--dash-ink-3) hover:text-(--dash-ink)",
                  )}
                >
                  {t.label}
                  {deals !== null && (t.value !== "ATTENTION" || n > 0) && (
                    <span className={cn(
                      "dash-num rounded-full px-1.5 text-[0.6875rem] font-semibold",
                      t.value === "ATTENTION" ? "bg-(--dash-brass-wash) text-(--dash-brass)" : "bg-(--dash-wash) text-(--dash-ink-2)",
                    )}>
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex w-full items-center gap-2 pb-2.5 sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:flex-none">
              <span className="sr-only">Search rooms</span>
              <span aria-hidden className="material-symbols-outlined pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[16px] text-(--dash-ink-3)">search</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search rooms"
                className="w-full sm:w-60 rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) py-1.5 pr-3 pl-8 text-sm text-(--dash-ink) placeholder:text-(--dash-ink-3) outline-none focus:border-(--dash-blue-2) focus:ring-2 focus:ring-(--dash-blue-5)"
              />
            </label>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-(--dash-ink-3)">
              <span className="hidden sm:inline">Sort</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as RoomSort)}
                className="rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-2 py-1.5 text-xs font-medium text-(--dash-ink-2) outline-none focus:border-(--dash-blue-2)"
              >
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {/* Grid */}
        {deals === null ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="dash-panel flex flex-col gap-3.5 px-5 py-4">
                <Skeleton.Line width="60%" height={14} />
                <Skeleton.Line width="40%" height={11} />
                <Skeleton width="100%" height={6} rounded="full" />
                <Skeleton.Line width="75%" height={11} />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <p className="text-sm">
            <span className="text-(--dash-red)">Couldn&apos;t load your data rooms.</span>{" "}
            <button type="button" onClick={load} className="dash-link">Retry</button>
          </p>
        ) : all.length === 0 ? (
          <div className="dash-panel max-w-xl px-6 py-8">
            <h2 className="dash-display text-xl text-(--dash-ink)">No data rooms yet</h2>
            <p className="mt-2 text-sm text-(--dash-ink-2)">
              Every deal gets a data room with standard diligence folders. Create one here, or add a deal from the pipeline and its room appears automatically.
            </p>
            <button type="button" onClick={() => setCreateOpen(true)} className="dash-btn-primary mt-4 rounded-md px-4 py-2 text-sm font-semibold">New room</button>
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-sm text-(--dash-ink-2)">
            {query
              ? <>No rooms match “{query}”. <button type="button" onClick={() => setQuery("")} className="dash-link">Clear search</button></>
              : tab === "ATTENTION"
                ? stillLoading ? "Checking rooms…" : "Nothing needs attention. Every active room is on track."
                : "No rooms in this view."}
          </p>
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {visible.map((d) => (
              <RoomCard
                key={d.id}
                deal={d}
                status={statuses.get(d.id)}
                failed={failed.has(d.id)}
                showCreated={dupes.has(d.name || d.companyName || "")}
                now={now}
                onRetry={() => retry(d.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateRoomSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => router.push(`/data-room/${id}`)}
        onError={(message) => undo.show({ message, tone: "error" })}
      />
      <UndoBar notice={undo.notice} onDismiss={undo.dismiss} />
    </div>
  );
}

function CreateRoomSheet({ open, onClose, onCreated, onError }: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const close = () => { setName(""); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || creating) return;
    setCreating(true);
    try {
      // First pipeline stage, so the new deal shows on the Deals kanban.
      const deal = await api.post<RoomDeal>("/deals", { name: clean, companyName: clean, status: "ACTIVE", stage: "INITIAL_REVIEW" });
      if (deal?.id) onCreated(deal.id);
      close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't create the data room.";
      onError(err instanceof ApiError && err.status === 403 ? "You need Associate role or higher to create data rooms. Ask your admin." : msg);
    } finally {
      setCreating(false);
    }
  };

  return (
    <SideSheet
      open={open}
      onClose={close}
      eyebrow="Data Rooms"
      title="New data room"
      subtitle="Creates a deal with standard diligence folders, ready for uploads."
      footer={
        <>
          <button type="button" onClick={close} className="rounded-md px-3.5 py-2 text-sm font-medium text-(--dash-ink-2) hover:bg-(--dash-wash)">Cancel</button>
          <button type="button" onClick={() => formRef.current?.requestSubmit()} disabled={!name.trim() || creating} className="dash-btn-primary rounded-md px-4 py-2 text-sm font-semibold">
            {creating ? "Creating…" : "Create room"}
          </button>
        </>
      }
    >
      <form ref={formRef} onSubmit={submit} className="flex flex-col gap-1.5 px-6 py-5">
        <label htmlFor="room-name" className="text-[0.8125rem] font-medium text-(--dash-ink)">Room name</label>
        <input
          id="room-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          placeholder="e.g. Project Apollo — Acme Corp"
          className="w-full rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-3 py-2 text-sm text-(--dash-ink) placeholder:text-(--dash-ink-3) outline-none focus:border-(--dash-blue-2) focus:ring-2 focus:ring-(--dash-blue-5)"
        />
        <p className="text-xs text-(--dash-ink-3)">Use the deal or project name your team will recognise.</p>
      </form>
    </SideSheet>
  );
}

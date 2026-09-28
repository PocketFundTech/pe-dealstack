"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { getGreeting } from "./components";

interface MastheadProps {
  firstName: string;
  loading: boolean;
  needsYou: number;
  liveDeals: number;
  inDiligence: number;
  lastUpdated: number | null;
  refreshing: boolean;
  now: number;
  isEditing: boolean;
  onRefresh: () => void;
  onNewDeal: () => void;
  onAddWidget: () => void;
  onToggleEdit: () => void;
}

function updatedLabel(last: number | null, now: number): string {
  if (!last) return "";
  const mins = Math.floor((now - last) / 60_000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins} min ago`;
  return `Updated ${Math.floor(mins / 60)}h ago`;
}

function CustomizeMenu({ isEditing, onAddWidget, onToggleEdit }: Pick<MastheadProps, "isEditing" | "onAddWidget" | "onToggleEdit">) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (isEditing) {
    return (
      <button type="button" onClick={onToggleEdit} className="dash-btn-primary rounded-md px-3.5 py-2 text-sm font-semibold">
        Done editing
      </button>
    );
  }

  const item = "flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left text-sm text-(--dash-ink) hover:bg-(--dash-wash) hover:text-(--dash-blue)";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="dash-btn-ghost flex items-center gap-1 rounded-md py-2 pl-3.5 pr-2.5 text-sm font-medium"
      >
        Customize
        <span aria-hidden className={cn("material-symbols-outlined text-[18px] transition-transform", open && "rotate-180")}>expand_more</span>
      </button>
      {open && (
        <div role="menu" className="dash-pop absolute right-0 top-full z-30 mt-1.5 w-max min-w-52 rounded-lg border border-(--dash-rule) bg-(--dash-panel) py-1 shadow-[0_16px_40px_-16px_oklch(0.25_0.05_252/0.35)]">
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onAddWidget(); }}>
            <span aria-hidden className="material-symbols-outlined text-[18px]">add_circle</span>
            Add or remove widgets
          </button>
          <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); onToggleEdit(); }}>
            <span aria-hidden className="material-symbols-outlined text-[18px]">drag_indicator</span>
            Rearrange side panel
          </button>
        </div>
      )}
    </div>
  );
}

export function Masthead(props: MastheadProps) {
  const { firstName, loading, needsYou, liveDeals, inDiligence, lastUpdated, refreshing, now, onRefresh, onNewDeal } = props;
  const today = new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <header className="relative z-20 flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <p className="dash-label">{today}</p>
          <h1 className="dash-display mt-2 text-[1.75rem] leading-[1.1] text-(--dash-ink) md:text-[2.125rem]">
            {getGreeting()}, {firstName}
          </h1>
          <p className="mt-2 min-h-6 max-w-[65ch] text-[0.9375rem] text-(--dash-ink-2)">
            {loading ? (
              <span className="inline-block h-4 w-80 max-w-full animate-pulse rounded bg-(--dash-wash) align-middle" />
            ) : (
              <>
                {needsYou > 0 ? (
                  <a href="#today-heading" className="font-semibold text-(--dash-ink) underline decoration-(--dash-rule-strong) underline-offset-4 hover:decoration-(--dash-blue)">
                    {plural(needsYou, "thing needs", "things need")} you today.
                  </a>
                ) : (
                  <span className="font-semibold text-(--dash-ink)">Nothing urgent today.</span>
                )}{" "}
                {plural(liveDeals, "live deal", "live deals")}
                {inDiligence > 0 && <>, {inDiligence} in diligence</>}.
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {lastUpdated && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh dashboard"
              className="mr-1 flex items-center gap-1.5 rounded-md px-2 py-2 text-xs text-(--dash-ink-3) transition-colors hover:text-(--dash-blue) disabled:opacity-60"
            >
              <span aria-hidden className={cn("material-symbols-outlined text-[16px]", refreshing && "animate-spin")}>refresh</span>
              <span className="hidden sm:inline">{refreshing ? "Refreshing…" : updatedLabel(lastUpdated, now)}</span>
            </button>
          )}
          <CustomizeMenu {...props} />
          <button
            type="button"
            onClick={onNewDeal}
            className="dash-btn-primary flex items-center gap-1.5 rounded-md py-2 pl-3 pr-4 text-sm font-semibold"
          >
            <span aria-hidden className="material-symbols-outlined text-[18px]">add</span>
            New deal
          </button>
        </div>
      </div>
      <div className="dash-double-rule" />
    </header>
  );
}

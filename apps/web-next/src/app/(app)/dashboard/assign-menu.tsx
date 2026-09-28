"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { TeamMember } from "./use-dashboard-data";

export { Avatar, initials } from "@/components/dash/avatar";
import { Avatar } from "@/components/dash/avatar";

/**
 * "Assign ▾" — a small listbox of teammates. Loads the team lazily on first
 * open; keyboard: ArrowUp/Down to move, Enter to pick, Esc to close.
 */
export function AssignMenu({
  loadTeam,
  onAssign,
  className,
}: {
  loadTeam: () => Promise<TeamMember[]>;
  onAssign: (m: TeamMember) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setActive(0);
      const rect = rootRef.current?.getBoundingClientRect();
      setDropUp(Boolean(rect && window.innerHeight - rect.bottom < 280 && rect.top > 280));
      const list = await loadTeam();
      setTeam(list);
      requestAnimationFrame(() => listRef.current?.focus());
    }
  };

  const pick = (m: TeamMember) => {
    setOpen(false);
    onAssign(m);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className="dash-btn-ghost flex items-center gap-1 whitespace-nowrap rounded-md py-1 pl-2.5 pr-1.5 text-xs font-semibold"
      >
        Assign
        <span aria-hidden className="material-symbols-outlined text-[16px]">expand_more</span>
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Assign owner"
          onKeyDown={(e) => {
            if (!team?.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, team.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); pick(team[active]); }
            if (e.key === "Escape") setOpen(false);
          }}
          className={cn("dash-pop absolute right-0 z-30 max-h-64 w-56 overflow-y-auto rounded-lg border border-(--dash-rule) bg-(--dash-panel) py-1 shadow-[0_16px_40px_-16px_oklch(0.25_0.05_252/0.35)] outline-none", dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5")}
        >
          {team === null ? (
            <li className="px-3 py-2 text-xs text-(--dash-ink-3)">Loading team…</li>
          ) : team.length === 0 ? (
            <li className="px-3 py-2 text-xs text-(--dash-ink-3)">No teammates found</li>
          ) : (
            team.map((m, i) => {
              const label = m.name || m.email || "Unnamed";
              return (
                <li
                  key={m.id}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(m)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm",
                    i === active ? "bg-(--dash-wash) text-(--dash-blue)" : "text-(--dash-ink)",
                  )}
                >
                  <Avatar name={label} size={24} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import type { Deal } from "./components";
import { groupSectors, isLiveDeal, type SectorGroup } from "./triage";
import { WidgetShell } from "./widgets/shell";

const RAMP = ["var(--dash-blue)", "var(--dash-blue-2)", "var(--dash-blue-3)", "var(--dash-blue-4)", "var(--dash-blue-5)"];

/** Ranked sector bars. Near-duplicate spellings are merged (triage.sectorKey);
 *  each row opens its deals in the drawer. */
export function SectorMix({ deals, loading, onOpenSector }: {
  deals: Deal[];
  loading: boolean;
  onOpenSector: (group: SectorGroup) => void;
}) {
  const groups = groupSectors(deals.filter(isLiveDeal));
  const max = Math.max(1, ...groups.map((g) => g.count));

  return (
    <WidgetShell
      title="Portfolio Allocation"
      headerRight={<span className="text-xs text-(--dash-ink-3)">by live deals</span>}
    >
      {loading ? (
        <div className="flex flex-col gap-4 px-5 py-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton.Line width={`${60 - i * 10}%`} height={11} />
              <Skeleton width="100%" height={4} rounded="full" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2)">
          Your sector mix appears here once live deals have an industry set.
        </p>
      ) : (
        <ol className="py-2">
          {groups.map((g, i) => (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => onOpenSector(g)}
                className="group flex w-full flex-col gap-1.5 px-5 py-2 text-left transition-colors hover:bg-(--dash-paper)"
              >
                <span className="flex w-full items-baseline justify-between gap-3 text-[0.8125rem]">
                  <span className="truncate text-(--dash-ink) group-hover:text-(--dash-blue)">{g.label}</span>
                  <span className="dash-num shrink-0">
                    <span className="text-(--dash-ink-3)">{g.count} · </span>
                    <span className="font-semibold text-(--dash-ink)">{g.pct}%</span>
                  </span>
                </span>
                <span className="block h-1 w-full overflow-hidden rounded-full bg-(--dash-wash)" aria-hidden>
                  <span
                    className="dash-bar block h-full rounded-full"
                    style={{ width: `${(g.count / max) * 100}%`, background: g.key === "others" ? "var(--dash-rule-strong)" : RAMP[i] }}
                  />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </WidgetShell>
  );
}

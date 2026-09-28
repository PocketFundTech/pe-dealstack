"use client";

import Link from "next/link";
import { SideSheet } from "@/components/dash/side-sheet";
import { formatCurrency } from "@/lib/formatters";
import { stageLabel, type Deal } from "./components";
import { isStale, touchLabel } from "./triage";

export interface DrawerContent {
  eyebrow: string;
  title: string;
  deals: Deal[];
}

/** A slice of the pipeline (a stage, a sector) in the shared side sheet. */
export function DealsDrawer({ content, now, onClose }: { content: DrawerContent | null; now: number; onClose: () => void }) {
  const sorted = content
    ? [...content.deals].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    : [];

  return (
    <SideSheet
      open={!!content}
      onClose={onClose}
      eyebrow={content?.eyebrow}
      title={content?.title ?? ""}
      subtitle={content && <span className="dash-num">{content.deals.length} {content.deals.length === 1 ? "deal" : "deals"}</span>}
      footer={<Link href="/deals" onClick={onClose} className="dash-link mr-auto text-sm">Open the full pipeline &rarr;</Link>}
    >
      {sorted.length === 0 ? (
        <p className="px-6 py-8 text-sm text-(--dash-ink-2)">
          Nothing here yet. Deals appear as you move them through the{" "}
          <Link href="/deals" onClick={onClose} className="dash-link">pipeline</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-(--dash-rule)">
          {sorted.map((d) => {
            const stale = isStale(d, now);
            return (
              <li key={d.id}>
                <Link
                  href={`/deals/${d.id}`}
                  onClick={onClose}
                  className="group flex items-center justify-between gap-4 px-6 py-3.5 transition-colors hover:bg-(--dash-paper)"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-(--dash-ink) group-hover:text-(--dash-blue)">{d.name}</p>
                    <p className="truncate text-xs text-(--dash-ink-3)">
                      {stageLabel(d.stage)} · <span className={stale ? "font-medium text-(--dash-brass)" : undefined}>{touchLabel(d.updatedAt, now)}</span>
                      {d.assignedUser?.name ? ` · ${d.assignedUser.name}` : ""}
                    </p>
                  </div>
                  <span className="dash-num shrink-0 text-sm font-semibold text-(--dash-ink)">
                    {d.dealSize != null ? formatCurrency(d.dealSize, d.currency) : <span className="font-normal text-(--dash-ink-3)">—</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </SideSheet>
  );
}

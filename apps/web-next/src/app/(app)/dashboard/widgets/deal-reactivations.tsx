"use client";

// "Worth revisiting" — dormant deals the reactivation engine re-scored and
// found materially improved.
//
// This is the widget that makes a passed pile an asset instead of a
// graveyard. Demo-call origin: Aryamaan M8's "the other 1,496 still
// matter" and Martin M14's "a 4/10 becomes an 8/10 and no tool does this".

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

interface Reactivation {
  id: string;
  dealId: string;
  dealName: string | null;
  companyName: string | null;
  trigger: "FINANCIALS_UPDATED" | "CRITERIA_CHANGED" | "REVISIT_DUE" | "MANUAL";
  previousScore: number | null;
  newScore: number | null;
  previousVerdict: string | null;
  newVerdict: string | null;
  delta: { resolvedMisses?: string[]; gainedHits?: string[]; newFlags?: string[] } | null;
  createdAt: string;
}

const TRIGGER_LABEL: Record<Reactivation["trigger"], string> = {
  FINANCIALS_UPDATED: "New financials",
  CRITERIA_CHANGED: "Your criteria changed",
  REVISIT_DUE: "Revisit date reached",
  MANUAL: "Re-scored by hand",
};

function headline(r: Reactivation): string {
  return (
    r.delta?.resolvedMisses?.[0] ??
    r.delta?.gainedHits?.[0] ??
    `Now scores ${r.newVerdict ?? "better"}`
  );
}

export function DealReactivationsWidget() {
  const [items, setItems] = useState<Reactivation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ reactivations: Reactivation[] }>("/deals/reactivations");
      setItems(res.reactivations);
    } catch (err) {
      // Migration not yet applied, or no access — an empty state is the
      // honest answer here, not an error the user can act on.
      console.warn("reactivations load failed", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dismiss = useCallback(
    async (r: Reactivation) => {
      setItems((current) => current.filter((i) => i.id !== r.id));
      try {
        await api.patch(`/deals/${r.dealId}/reactivations/${r.id}`, { status: "DISMISSED" });
      } catch (err) {
        console.warn("reactivation dismiss failed", err);
        void load();
      }
    },
    [load],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-text-muted">restart_alt</span>
        <h3 className="text-sm font-semibold text-text-main">Worth revisiting</h3>
        {items.length > 0 && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
            {items.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-6 text-center">
          <span className="material-symbols-outlined text-2xl text-text-muted">inventory_2</span>
          <p className="mt-2 text-xs text-text-muted">Nothing to revisit yet</p>
          <p className="mt-1 text-[11px] text-text-muted">
            Passed deals get re-scored when their financials or your criteria change.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2 overflow-y-auto">
          {items.map((r) => (
            <li
              key={r.id}
              className="group rounded-lg border border-border-subtle bg-white px-3 py-2.5 transition-colors hover:border-gray-300"
            >
              <div className="flex items-start justify-between gap-2">
                <Link href={`/deals/${r.dealId}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-main">
                      {r.companyName || r.dealName || "Untitled deal"}
                    </span>
                    {r.previousScore != null && r.newScore != null && (
                      <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">
                        {r.previousScore} → {r.newScore}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-secondary">{headline(r)}</p>
                  <p className="mt-0.5 text-[11px] text-text-muted">{TRIGGER_LABEL[r.trigger]}</p>
                </Link>
                <button
                  onClick={() => void dismiss(r)}
                  title="Dismiss"
                  className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:bg-gray-50 hover:text-text-main group-hover:opacity-100"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

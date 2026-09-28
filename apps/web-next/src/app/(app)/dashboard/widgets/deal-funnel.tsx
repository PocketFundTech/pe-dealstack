"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { WidgetShell, WidgetEmpty, WidgetError, WidgetLoading } from "./shell";

// Ported from deal-funnel.js.
const STAGES: Array<{ key: string; label: string; color: string; also?: string[] }> = [
  { key: "INITIAL_REVIEW", label: "Sourcing", color: "var(--dash-blue-4)" },
  { key: "DUE_DILIGENCE", label: "Due Diligence", color: "var(--dash-blue-2)" },
  { key: "IOI_SUBMITTED", label: "IOI / LOI", color: "var(--dash-blue)", also: ["LOI_SUBMITTED"] },
  { key: "NEGOTIATION", label: "Negotiation", color: "var(--dash-blue)", also: ["CLOSING"] },
  { key: "CLOSED_WON", label: "Closed", color: "var(--dash-green)" },
];

type DealRow = { stage: string; status?: string };

export function DealFunnelWidget() {
  const [rows, setRows] = useState<Array<{ label: string; color: string; count: number; pct: number }> | null>(null);
  const [error, setError] = useState(false);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<DealRow[] | { deals: DealRow[] }>("/deals?limit=500");
        if (cancelled) return;
        const deals = Array.isArray(data) ? data : data.deals || [];
        const active = deals.filter((d) => d.status !== "ARCHIVED");
        if (active.length === 0) {
          setEmpty(true);
          return;
        }
        const total = active.length;
        const computed = STAGES.map((stage) => {
          const keys = [stage.key, ...(stage.also || [])];
          const count = active.filter((d) => keys.includes(d.stage)).length;
          const pct = Math.round((count / total) * 100);
          return { label: stage.label, color: stage.color, count, pct };
        });
        setRows(computed);
      } catch (err) {
        console.warn("[dashboard/deal-funnel] failed to load deals:", err);
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <WidgetShell title="Deal Funnel" icon="filter_alt">
      {error ? (
        <WidgetError message="Could not load deal funnel" />
      ) : empty ? (
        <WidgetEmpty message="No deals yet" icon="filter_alt" />
      ) : !rows ? (
        <WidgetLoading />
      ) : (
        <ol className="px-5 py-4 flex flex-col gap-3.5">
          {rows.map((r) => (
            <li key={r.label} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between text-[0.8125rem]">
                <span className="text-(--dash-ink)">{r.label}</span>
                <span className="dash-num text-(--dash-ink-3)">
                  <strong className="font-semibold text-(--dash-ink)">{r.count}</strong> · {r.pct}%
                </span>
              </div>
              <div className="h-1 rounded-full bg-(--dash-wash) overflow-hidden">
                {r.count > 0 && (
                  <div className="dash-bar h-full rounded-full" style={{ width: `${r.pct}%`, backgroundColor: r.color }} />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </WidgetShell>
  );
}

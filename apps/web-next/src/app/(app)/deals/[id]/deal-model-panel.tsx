"use client";

// "Build model" — the assumptions a partner edits, and the .xlsx download.
//
// The live preview (entry EV, equity cheque, implied MoM/IRR) exists so the
// user gets feedback before downloading. It is a convenience echo of what
// the workbook computes, NOT the source of truth: the file itself is fully
// formula-driven, and these figures are recomputed there from the same
// inputs. If they ever disagree, the workbook is right.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";

interface Assumptions {
  entryMultiple: number;
  entryBasis: "EBITDA" | "REVENUE";
  transactionFeesPct: number;
  debtQuantumMode: "MULTIPLE" | "ABSOLUTE";
  debtQuantum: number;
  interestRate: number;
  amortPctPerYear: number;
  cashSweepPct: number;
  projectionYears: number;
  revenueGrowthPct: number[];
  ebitdaMarginPct: number[];
  capexPctRevenue: number;
  nwcPctRevenue: number;
  taxRate: number;
  daPctRevenue: number;
  exitMultiple: number;
  exitYear: number;
  wacc: number;
  dscrTarget: number;
  unitScale: "MILLIONS" | "THOUSANDS";
  currency: string;
}

interface HistoryRow {
  period: string;
  revenue?: number;
  ebitda?: number;
}

interface ModelResponse {
  assumptions: Assumptions;
  isDerived: boolean;
  history: HistoryRow[];
  currency: string;
  unitScale: string;
}

type NumericKey =
  | "entryMultiple" | "transactionFeesPct" | "debtQuantum" | "interestRate"
  | "amortPctPerYear" | "cashSweepPct" | "capexPctRevenue" | "nwcPctRevenue"
  | "taxRate" | "daPctRevenue" | "exitMultiple" | "exitYear" | "wacc" | "dscrTarget";

const GROUPS: Array<{ title: string; fields: Array<{ key: NumericKey; label: string; suffix: string; step?: number }> }> = [
  {
    title: "Entry",
    fields: [
      { key: "entryMultiple", label: "Entry multiple", suffix: "x", step: 0.25 },
      { key: "transactionFeesPct", label: "Transaction fees", suffix: "%", step: 0.5 },
    ],
  },
  {
    title: "Capital structure",
    fields: [
      { key: "debtQuantum", label: "Debt", suffix: "x EBITDA", step: 0.25 },
      { key: "interestRate", label: "Interest rate", suffix: "%", step: 0.25 },
      { key: "amortPctPerYear", label: "Amortisation", suffix: "% / yr", step: 1 },
      { key: "cashSweepPct", label: "Cash sweep", suffix: "% of FCF", step: 5 },
      { key: "dscrTarget", label: "DSCR target", suffix: "x", step: 0.05 },
    ],
  },
  {
    title: "Operating",
    fields: [
      { key: "capexPctRevenue", label: "Capex", suffix: "% of revenue", step: 0.5 },
      { key: "nwcPctRevenue", label: "NWC", suffix: "% of revenue", step: 1 },
      { key: "daPctRevenue", label: "D&A", suffix: "% of revenue", step: 0.5 },
      { key: "taxRate", label: "Tax rate", suffix: "%", step: 1 },
    ],
  },
  {
    title: "Exit",
    fields: [
      { key: "exitMultiple", label: "Exit multiple", suffix: "x", step: 0.25 },
      { key: "exitYear", label: "Exit year", suffix: "", step: 1 },
      { key: "wacc", label: "WACC", suffix: "%", step: 0.5 },
    ],
  },
];

function fmtMoney(value: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return `${symbol}${value.toFixed(1)}m`;
}

export function DealModelPanel({ dealId }: { dealId: string }) {
  const { showToast } = useToast();
  const [model, setModel] = useState<ModelResponse | null>(null);
  const [assumptions, setAssumptions] = useState<Assumptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<ModelResponse>(`/deals/${dealId}/model`);
        setModel(res);
        setAssumptions(res.assumptions);
      } catch (err) {
        // Either no financials yet or the migration hasn't run — both are
        // empty states the user can act on, not errors to shout about.
        console.warn("deal model load failed", err);
        setBlocked(err instanceof Error ? err.message : "Could not load model inputs");
      } finally {
        setLoading(false);
      }
    })();
  }, [dealId]);

  const set = useCallback((key: NumericKey, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setAssumptions((a) => (a ? { ...a, [key]: value } : a));
  }, []);

  const setSeries = useCallback((key: "revenueGrowthPct" | "ebitdaMarginPct", raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setAssumptions((a) => (a ? { ...a, [key]: a[key].map(() => value) } : a));
  }, []);

  // Echo of the workbook's own arithmetic — see the note at the top.
  const preview = useMemo(() => {
    if (!assumptions || !model) return null;
    const lastEbitda = [...model.history].reverse().find((h) => typeof h.ebitda === "number")?.ebitda;
    if (typeof lastEbitda !== "number") return null;

    const entryEv = lastEbitda * assumptions.entryMultiple;
    const debt = lastEbitda * assumptions.debtQuantum;
    const equity = entryEv * (1 + assumptions.transactionFeesPct / 100) - debt;

    let ebitda = lastEbitda;
    for (let y = 0; y < assumptions.exitYear; y++) {
      const growth = (assumptions.revenueGrowthPct[y] ?? 0) / 100;
      ebitda = ebitda * (1 + growth);
    }
    const exitEv = ebitda * assumptions.exitMultiple;
    const proceeds = exitEv - Math.max(0, debt * (1 - (assumptions.amortPctPerYear / 100) * assumptions.exitYear));
    const mom = equity > 0 ? proceeds / equity : null;
    const irr = mom && mom > 0 ? Math.pow(mom, 1 / assumptions.exitYear) - 1 : null;

    return { entryEv, equity, mom, irr };
  }, [assumptions, model]);

  const save = useCallback(async () => {
    if (!assumptions) return;
    setBusy(true);
    try {
      await api.put(`/deals/${dealId}/model`, assumptions);
      showToast("Assumptions saved", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't save assumptions", "error");
    } finally {
      setBusy(false);
    }
  }, [dealId, assumptions, showToast]);

  const download = useCallback(async () => {
    if (!assumptions) return;
    setBusy(true);
    try {
      const res = await authFetchRaw(`/deals/${dealId}/model/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assumptions),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download =
        res.headers.get("content-disposition")?.match(/filename="(.+?)"/)?.[1] ?? "model.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't build the model", "error");
    } finally {
      setBusy(false);
    }
  }, [dealId, assumptions, showToast]);

  if (loading) {
    return <div className="h-32 animate-pulse rounded-xl bg-gray-100" />;
  }

  if (blocked || !assumptions || !model) {
    return (
      <div className="rounded-xl border border-dashed border-border-subtle px-6 py-8 text-center">
        <span className="material-symbols-outlined text-2xl text-text-muted">table_chart</span>
        <p className="mt-2 text-sm font-medium text-text-main">No model yet</p>
        <p className="mt-1 text-xs text-text-muted">
          {blocked ?? "Extract this deal's financials and the model builds from them."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Build model</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {model.history.length} historical period{model.history.length === 1 ? "" : "s"} ·{" "}
            {model.currency} in millions
            {model.isDerived && " · starting from derived defaults"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium text-text-secondary hover:bg-gray-50 disabled:opacity-60"
          >
            Save
          </button>
          <button
            onClick={() => void download()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            {busy ? "Building…" : "Download .xlsx"}
          </button>
        </div>
      </div>

      {preview && (
        <div className="grid grid-cols-2 gap-px border-b border-border-subtle bg-border-subtle sm:grid-cols-4">
          {[
            { label: "Entry EV", value: fmtMoney(preview.entryEv, model.currency) },
            { label: "Equity cheque", value: fmtMoney(preview.equity, model.currency) },
            { label: "MoM", value: preview.mom ? `${preview.mom.toFixed(1)}x` : "—" },
            { label: "IRR", value: preview.irr ? `${(preview.irr * 100).toFixed(0)}%` : "—" },
          ].map((m) => (
            <div key={m.label} className="bg-white px-4 py-3">
              <p className="text-xs text-text-muted">{m.label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-main">{m.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 px-5 py-5 md:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {group.title}
            </h4>
            <div className="flex flex-col gap-2">
              {group.fields.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-text-secondary">{f.label}</span>
                  <span className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step={f.step ?? 0.1}
                      value={assumptions[f.key]}
                      onChange={(e) => set(f.key, e.target.value)}
                      className="w-24 rounded-lg border border-border-subtle px-2 py-1.5 text-right text-sm tabular-nums focus:border-[#003366] focus:outline-none"
                    />
                    <span className="w-20 text-xs text-text-muted">{f.suffix}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}

        <div className="md:col-span-2">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Projection ({assumptions.projectionYears} years)
          </h4>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2">
              <span className="text-sm text-text-secondary">Revenue growth</span>
              <input
                type="number"
                step={0.5}
                value={assumptions.revenueGrowthPct[0] ?? 0}
                onChange={(e) => setSeries("revenueGrowthPct", e.target.value)}
                className="w-24 rounded-lg border border-border-subtle px-2 py-1.5 text-right text-sm tabular-nums focus:border-[#003366] focus:outline-none"
              />
              <span className="text-xs text-text-muted">% / yr</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-sm text-text-secondary">EBITDA margin</span>
              <input
                type="number"
                step={0.5}
                value={assumptions.ebitdaMarginPct[0] ?? 0}
                onChange={(e) => setSeries("ebitdaMarginPct", e.target.value)}
                className="w-24 rounded-lg border border-border-subtle px-2 py-1.5 text-right text-sm tabular-nums focus:border-[#003366] focus:outline-none"
              />
              <span className="text-xs text-text-muted">%</span>
            </label>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            These set every projected year at once. Per-year overrides live on the Assumptions sheet
            of the downloaded file — every figure in the workbook is a live formula, so editing there
            recalculates the whole model.
          </p>
        </div>
      </div>
    </div>
  );
}

"use client";

// "Build model" — the assumptions a partner edits, and the .xlsx download.
//
// The live preview (entry EV, equity cheque, implied MoM/IRR, every line's
// projection) exists so the user gets feedback before downloading. It runs
// the same arithmetic as the workbook's formulas (projectModel in
// @ai-crm/shared: costs as % of revenue, EBITDA = revenue − costs, the debt
// schedule and exit), but the file itself is the source of truth: if they
// ever disagree, the workbook is right.

import { useCallback, useEffect, useMemo, useState } from "react";
import { projectModel, type DriverMethod } from "@ai-crm/shared";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";
import { DriverTable } from "./deal-model-driver-table";
import {
  SCALAR_GROUPS, convertDriver, fmtMoney,
  type Assumptions, type ModelResponse, type ScalarKey,
} from "./deal-model-types";

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

  const projection = useMemo(() => {
    if (!assumptions || !model?.lines?.length) return null;
    return projectModel(model.lines, model.baseValues ?? {}, assumptions);
  }, [assumptions, model]);

  const set = useCallback((key: ScalarKey, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setAssumptions((a) => (a ? { ...a, [key]: value } : a));
  }, []);

  const setDriverValue = useCallback((key: string, year: number, value: number) => {
    setAssumptions((a) => {
      if (!a) return a;
      const d = a.lineDrivers[key];
      const values = d.values.map((v, y) => (y === year ? value : v));
      return { ...a, lineDrivers: { ...a.lineDrivers, [key]: { ...d, values } } };
    });
  }, []);

  const setDriverMethod = useCallback((key: string, method: DriverMethod) => {
    setAssumptions((a) => {
      if (!a || !projection) return a;
      const converted = convertDriver(method, projection.values[key] ?? [], projection.revenue, projection.base[key] ?? 0);
      return { ...a, lineDrivers: { ...a.lineDrivers, [key]: converted } };
    });
  }, [projection]);

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

  const hasEntry = projection && model.base?.entrySource !== "missing";

  return (
    <div className="rounded-xl border border-border-subtle bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Build model</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {model.history.length} historical period{model.history.length === 1 ? "" : "s"} ·{" "}
            {model.currency} in millions
            {model.base && ` · base ${model.base.label}`}
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

      {hasEntry && (
        <div className="grid grid-cols-2 gap-px border-b border-border-subtle bg-border-subtle sm:grid-cols-4">
          {[
            { label: "Entry EV", value: fmtMoney(projection.entryEv, model.currency) },
            { label: "Equity cheque", value: fmtMoney(projection.equity, model.currency) },
            { label: "MoM", value: projection.mom ? `${projection.mom.toFixed(1)}x` : "—" },
            { label: "IRR", value: projection.irr !== null ? `${(projection.irr * 100).toFixed(0)}%` : "—" },
          ].map((m) => (
            <div key={m.label} className="bg-white px-4 py-3">
              <p className="text-xs text-text-muted">{m.label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-main">{m.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 px-5 py-5 md:grid-cols-2">
        {SCALAR_GROUPS.map((group) => (
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
            P&amp;L drivers by line ({assumptions.projectionYears} years)
          </h4>
          <DriverTable
            lines={model.lines ?? []}
            drivers={assumptions.lineDrivers ?? {}}
            projection={projection}
            years={assumptions.projectionYears}
            onValue={setDriverValue}
            onMethod={setDriverMethod}
          />
          <p className="mt-3 text-xs text-text-muted">
            Every line is projected from its own driver; parents add up their accounts and subtotals
            are formulas. The downloaded workbook carries the same drivers as live Excel inputs.
          </p>
        </div>
      </div>
    </div>
  );
}

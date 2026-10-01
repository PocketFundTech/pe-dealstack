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
import {
  MODEL_CASES, balanceDriversOf, projectModel, summariseCase,
  type BalanceDrivers, type BalanceSeriesKey, type DriverMethod, type ModelCase,
} from "@ai-crm/shared";
import { api } from "@/lib/api";
import { authFetchRaw } from "@/app/(app)/deal-intake/components";
import { useToast } from "@/providers/ToastProvider";
import { DriverTable } from "./deal-model-driver-table";
import { CaseTabs, ScenarioSummary } from "./deal-model-scenarios";
import { BalanceSection } from "./deal-model-balance";
import {
  SCALAR_GROUPS, convertDriver, fmtMoney,
  type Assumptions, type CasesResponse, type ModelStructure, type ScalarKey,
} from "./deal-model-types";

type ByCase<T> = Record<ModelCase, T>;
const byCase = <T,>(fn: (c: ModelCase) => T) =>
  Object.fromEntries(MODEL_CASES.map((c) => [c, fn(c)])) as ByCase<T>;

export function DealModelPanel({ dealId }: { dealId: string }) {
  const { showToast } = useToast();
  const [model, setModel] = useState<ModelStructure | null>(null);
  const [cases, setCases] = useState<ByCase<Assumptions> | null>(null);
  const [saved, setSaved] = useState<ByCase<boolean>>(() => byCase(() => false));
  const [dirty, setDirty] = useState<ByCase<boolean>>(() => byCase(() => false));
  const [active, setActive] = useState<ModelCase>("Base");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const assumptions = cases?.[active] ?? null;

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<CasesResponse>(`/deals/${dealId}/model/cases`);
        const { cases: list, ...structure } = res;
        setModel(structure);
        setCases(byCase((c) => list.find((x) => x.case === c)!.assumptions));
        setSaved(byCase((c) => !!list.find((x) => x.case === c)?.saved));
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
    return projectModel(model.lines, model.baseValues ?? {}, assumptions, model.opening ?? {});
  }, [assumptions, model]);

  const summaries = useMemo(() => {
    if (!cases || !model?.lines?.length || model.base?.entrySource === "missing") return null;
    return byCase((c) => summariseCase(model.lines, model.baseValues ?? {}, cases[c], model.opening ?? {}));
  }, [cases, model]);

  /** Edit the active case only. */
  const setAssumptions = useCallback((fn: (a: Assumptions) => Assumptions) => {
    setCases((all) => (all ? { ...all, [active]: fn(all[active]) } : all));
    setDirty((d) => ({ ...d, [active]: true }));
  }, [active]);

  const set = useCallback((key: ScalarKey, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setAssumptions((a) => ({ ...a, [key]: value }));
  }, [setAssumptions]);

  const setDriverValue = useCallback((key: string, year: number, value: number) => {
    setAssumptions((a) => {
      const d = a.lineDrivers[key];
      const values = d.values.map((v, y) => (y === year ? value : v));
      return { ...a, lineDrivers: { ...a.lineDrivers, [key]: { ...d, values } } };
    });
  }, [setAssumptions]);

  const setDriverMethod = useCallback((key: string, method: DriverMethod) => {
    setAssumptions((a) => {
      if (!projection) return a;
      const converted = convertDriver(method, projection.values[key] ?? [], projection.revenue, projection.base[key] ?? 0);
      return { ...a, lineDrivers: { ...a.lineDrivers, [key]: converted } };
    });
  }, [projection, setAssumptions]);

  /** One year of a working-capital / capex series (fix plan E3), active case only. */
  const setBalanceValue = useCallback((key: BalanceSeriesKey, year: number, value: number) => {
    setAssumptions((a) => {
      const bd = balanceDriversOf(a);
      return { ...a, balanceDrivers: { ...bd, [key]: bd[key].map((v, y) => (y === year ? value : v)) } };
    });
  }, [setAssumptions]);

  /** Working-capital / capex method: structural (one workbook layout), so every case switches. */
  const setBalanceMethods = useCallback((patch: Partial<Pick<BalanceDrivers, "nwcMethod" | "capexMethod">>) => {
    setCases((all) => all && byCase((c) => ({ ...all[c], balanceDrivers: { ...balanceDriversOf(all[c]), ...patch } })));
    setDirty(() => byCase(() => true));
  }, []);

  const save = useCallback(async () => {
    if (!assumptions) return;
    setBusy(true);
    try {
      await api.put(`/deals/${dealId}/model?case=${active}`, assumptions);
      setSaved((s) => ({ ...s, [active]: true }));
      setDirty((d) => ({ ...d, [active]: false }));
      showToast(`${active} case saved`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't save assumptions", "error");
    } finally {
      setBusy(false);
    }
  }, [dealId, assumptions, active, showToast]);

  const download = useCallback(async () => {
    if (!cases) return;
    setBusy(true);
    try {
      // All three cases (incl. unsaved edits); the workbook opens on the active one.
      const res = await authFetchRaw(`/deals/${dealId}/model/export?case=${active}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases, activeCase: active }),
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
  }, [dealId, cases, active, showToast]);

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
            {!saved.Base && " · starting from derived defaults"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CaseTabs active={active} saved={saved} dirty={dirty} onSelect={setActive} />
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg border border-border-subtle px-3 py-2 text-sm font-medium text-text-secondary hover:bg-gray-50 disabled:opacity-60"
          >
            Save {active}
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

      {summaries && (
        <div className="border-b border-border-subtle px-5 py-3">
          <ScenarioSummary summaries={summaries} active={active} currency={model.currency} />
          {!saved.Low || !saved.High ? (
            <p className="mt-2 text-xs text-text-muted">
              Unsaved Low / High cases start from Base: revenue growth ∓3pp, EBITDA margin ∓2pp, exit multiple ∓1.0x. Edit and save each case on its tab.
            </p>
          ) : null}
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
                      value={assumptions[f.key] ?? 0}
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
          <BalanceSection
            assumptions={assumptions}
            projection={projection}
            opening={model.opening}
            currency={model.currency}
            onSeries={setBalanceValue}
            onMethods={setBalanceMethods}
            onScalar={set}
          />
        </div>

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

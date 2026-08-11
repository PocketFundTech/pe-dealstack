"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ChartRenderer } from "./ChartRenderer";
import { AxisHint, Panel } from "./components";
import {
  CHART_TYPES,
  CURRENCY_LABEL,
  METRIC_CATALOG,
  PALETTE,
} from "./constants";
import type {
  ChartType,
  FinancialRow,
  Graph,
  GraphDraft,
  GraphSeries,
  SeriesType,
} from "./types";

interface BuilderProps {
  dealId: string;
  // Friendly subheader label (e.g. "Aurelia Foods · Project Lighthouse").
  // Optional because edit-mode reuses the saved graph's deal context — the
  // page passes whatever it has.
  dealLabel?: string;
  // When `null`, Builder is in create mode. When a Graph is passed, it's the
  // edit form and Save will PATCH that record.
  initial: Graph | null;
  onCancel: () => void;
  // Called *after* the API write succeeds with the persisted row. The parent
  // is responsible for showing the success toast / returning to the gallery.
  onSaved: (saved: Graph) => void;
}

export function Builder({ dealId, dealLabel, initial, onCancel, onSaved }: BuilderProps) {
  const [title, setTitle] = useState(initial?.title || "");
  const [chartType, setChartType] = useState<ChartType>(initial?.chartType || "combo");
  const [series, setSeries] = useState<GraphSeries[]>(initial?.series || []);

  // Financial timeseries for this deal. We fetch on mount (and re-fetch if
  // the dealId changes, e.g. user navigates from edit-of-deal-A → create-on-deal-B
  // without unmounting). `null` = loading, `[]` = loaded-but-empty, otherwise
  // we have rows.
  const [data, setData] = useState<FinancialRow[] | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  // Save submission state — disables the save button + flips its label.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setDataError(null);
    (async () => {
      try {
        const rows = await api.get<FinancialRow[]>(
          `/deals/${dealId}/financials/timeseries`,
        );
        if (cancelled) return;
        setData(Array.isArray(rows) ? rows : []);
      } catch (err) {
        if (cancelled) return;
        console.warn("[graphs] failed to load financials timeseries", err);
        setDataError(err instanceof Error ? err.message : "Failed to load financials");
        setData([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const draft = useMemo<GraphDraft>(
    () => ({ title: title.trim() || "Untitled graph", chartType, series }),
    [title, chartType, series],
  );

  const isSelected = (key: string) => series.some((s) => s.metricKey === key);

  function toggleMetric(key: string) {
    if (isSelected(key)) {
      setSeries(series.filter((s) => s.metricKey !== key));
      return;
    }
    const meta = METRIC_CATALOG.find((m) => m.key === key);
    const defaultType: SeriesType = meta?.kind === "percent" ? "line" : "bar";
    setSeries([
      ...series,
      {
        metricKey: key,
        seriesType: defaultType,
        color: PALETTE[series.length % PALETTE.length],
      },
    ]);
  }

  function updateSeries(key: string, patch: Partial<GraphSeries>) {
    setSeries(series.map((s) => (s.metricKey === key ? { ...s, ...patch } : s)));
  }

  function moveSeries(idx: number, dir: -1 | 1) {
    const next = [...series];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setSeries(next);
  }

  async function handleSave() {
    if (saving) return;
    if (!(title.trim().length > 0 && series.length > 0)) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = initial
        ? await api.patch<Graph>(`/graphs/${initial.id}`, draft)
        : await api.post<Graph>(`/deals/${dealId}/graphs`, draft);
      onSaved(saved);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save graph";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    title.trim().length > 0 && series.length > 0 && !saving;

  const grouped: Record<string, typeof METRIC_CATALOG> = {
    "P&L line items": METRIC_CATALOG.filter((m) => m.source === "P&L"),
    "Analysis metrics": METRIC_CATALOG.filter((m) => m.source === "Analysis"),
  };

  return (
    <div className="max-w-[1280px] mx-auto px-8 py-7">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onCancel}
            className="w-8 h-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:border-slate-300 flex items-center justify-center shrink-0"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 truncate">
              {initial ? "Edit graph" : "New graph"}
            </h1>
            <p className="text-xs text-slate-500 truncate">
              {dealLabel ?? "Compose a chart from P&L and analysis metrics"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onCancel}
            className="px-3.5 py-2 rounded-md text-sm border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              "px-3.5 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5",
              canSave
                ? "text-white hover:opacity-90"
                : "bg-slate-200 text-slate-400 cursor-not-allowed",
            )}
            style={canSave ? { backgroundColor: "#003366" } : undefined}
          >
            <span className="material-symbols-outlined text-[18px]">
              {saving ? "hourglass_top" : "check"}
            </span>
            {saving ? "Saving…" : "Save graph"}
          </button>
        </div>
      </div>

      {saveError && (
        <div className="mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {saveError}
          <button
            onClick={() => setSaveError(null)}
            className="ml-auto text-red-400 hover:text-red-600"
            aria-label="Dismiss error"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">
        {/* Config panel */}
        <div className="col-span-12 lg:col-span-5 space-y-5">
          <Panel title="Graph title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder='e.g. "Revenue vs Bottom Line + EBITDA Margin"'
              className="w-full px-3 py-2 text-sm rounded-md border border-slate-200 focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15 outline-none"
            />
          </Panel>

          <Panel title="Chart type">
            <div className="grid grid-cols-4 gap-2">
              {CHART_TYPES.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setChartType(c.key)}
                  className={cn(
                    "px-2.5 py-1.5 text-xs rounded-md border transition",
                    chartType === c.key
                      ? "text-white border-transparent"
                      : "bg-white text-slate-700 border-slate-200 hover:border-slate-300",
                  )}
                  style={
                    chartType === c.key ? { backgroundColor: "#003366" } : undefined
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
            {chartType === "combo" && (
              <p className="text-[11px] text-slate-500 mt-2">
                In combo mode each series can render as a bar, line, or area
                independently.
              </p>
            )}
          </Panel>

          <Panel title="Metrics">
            <div className="space-y-3">
              {Object.entries(grouped).map(([groupLabel, items]) => (
                <div key={groupLabel}>
                  <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">
                    {groupLabel}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((m) => {
                      const selected = isSelected(m.key);
                      return (
                        <button
                          key={m.key}
                          onClick={() => toggleMetric(m.key)}
                          className={cn(
                            "px-2.5 py-1 text-xs rounded-full border inline-flex items-center gap-1.5 transition",
                            selected
                              ? "border-transparent"
                              : "bg-white border-slate-200 text-slate-700 hover:border-slate-300",
                          )}
                          style={
                            selected
                              ? {
                                  backgroundColor: "#E6EEF5",
                                  borderColor: "#B8CCDD",
                                  color: "#003366",
                                }
                              : undefined
                          }
                        >
                          <span
                            className={cn(
                              "w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center",
                              !selected && "border-slate-300",
                            )}
                            style={
                              selected
                                ? {
                                    backgroundColor: "#003366",
                                    borderColor: "#003366",
                                  }
                                : undefined
                            }
                          >
                            {selected && (
                              <span className="material-symbols-outlined text-[10px] text-white">
                                check
                              </span>
                            )}
                          </span>
                          {m.label}
                          <span className="text-[9px] uppercase text-slate-400 ml-0.5">
                            {m.kind === "percent" ? "%" : "$"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {series.length > 0 && (
            <Panel title={`Configured series (${series.length})`}>
              <div className="space-y-2">
                {series.map((s, idx) => {
                  const meta = METRIC_CATALOG.find((m) => m.key === s.metricKey);
                  if (!meta) return null;
                  return (
                    <div
                      key={s.metricKey}
                      className="flex items-center gap-2 p-2 rounded-md border border-slate-200 bg-slate-50/60"
                    >
                      <div className="flex flex-col">
                        <button
                          onClick={() => moveSeries(idx, -1)}
                          disabled={idx === 0}
                          className="text-slate-400 hover:text-slate-700 disabled:opacity-30 text-[10px] leading-none"
                          title="Move up"
                        >
                          &#9650;
                        </button>
                        <button
                          onClick={() => moveSeries(idx, 1)}
                          disabled={idx === series.length - 1}
                          className="text-slate-400 hover:text-slate-700 disabled:opacity-30 text-[10px] leading-none"
                          title="Move down"
                        >
                          &#9660;
                        </button>
                      </div>
                      <label className="relative cursor-pointer">
                        <span
                          className="w-5 h-5 rounded-md border border-slate-300 block"
                          style={{ background: s.color }}
                        />
                        <input
                          type="color"
                          value={s.color}
                          onChange={(e) =>
                            updateSeries(s.metricKey, { color: e.target.value })
                          }
                          className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                      </label>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-slate-800 truncate">
                          {meta.label}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {meta.kind === "percent"
                            ? "Right axis (%)"
                            : `Left axis (${CURRENCY_LABEL})`}
                        </div>
                      </div>
                      {chartType === "combo" && (
                        <select
                          value={s.seriesType}
                          onChange={(e) =>
                            updateSeries(s.metricKey, {
                              seriesType: e.target.value as SeriesType,
                            })
                          }
                          className="text-xs px-1.5 py-1 rounded border border-slate-200 bg-white text-slate-700"
                        >
                          <option value="bar">Bar</option>
                          <option value="line">Line</option>
                          <option value="area">Area</option>
                        </select>
                      )}
                      <button
                        onClick={() => toggleMetric(s.metricKey)}
                        className="w-6 h-6 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center"
                        title="Remove"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          close
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>

        {/* Preview panel */}
        <div className="col-span-12 lg:col-span-7">
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  Live preview
                </div>
                <div className="text-sm font-semibold text-slate-900 mt-0.5">
                  {title || "Untitled graph"}
                </div>
              </div>
              <AxisHint series={series} />
            </div>
            <div className="h-[440px] px-3 pt-3 pb-2">
              <PreviewBody
                data={data}
                dataError={dataError}
                series={series}
                draft={draft}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-[11px] text-slate-500">
            <span className="font-medium text-slate-700">Tip · </span>
            Mix Revenue and Net Income as bars with EBITDA Margin&nbsp;% as a line in
            Combo mode to reproduce the canonical &ldquo;Revenue vs Bottom Line +
            EBITDA Margin&rdquo; view.
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreviewBodyProps {
  data: FinancialRow[] | null;
  dataError: string | null;
  series: GraphSeries[];
  draft: GraphDraft;
}

function PreviewBody({ data, dataError, series, draft }: PreviewBodyProps) {
  // Order matters: loading first (data === null) so we don't flash "no data"
  // before the request resolves.
  if (data === null) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center text-slate-500">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#003366] mb-3" />
        <div className="text-xs">Loading financials…</div>
      </div>
    );
  }

  // Treat a hard fetch error like "no data" — we still let the user configure
  // series; the inline banner up top will surface the error message on save.
  if (data.length === 0) {
    return <EmptyFinancials hint={dataError} />;
  }

  if (series.length === 0) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
          <span className="material-symbols-outlined text-[24px]">add</span>
        </div>
        <div className="text-sm text-slate-600 font-medium">Pick metrics to start</div>
        <div className="text-[11px] text-slate-400 max-w-xs mt-1">
          Absolute values render on the left axis; percentage metrics get their
          own right-hand axis automatically.
        </div>
      </div>
    );
  }

  return <ChartRenderer graph={draft} data={data} />;
}

function EmptyFinancials({ hint }: { hint?: string | null }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center text-amber-500 mb-3">
        <span className="material-symbols-outlined text-[22px]">insights</span>
      </div>
      <div className="text-sm text-slate-700 font-medium">No financials yet</div>
      <div className="text-[12px] text-slate-500 max-w-md mt-1">
        This deal has no financial statements yet. Upload financials on the deal
        page to start building graphs.
      </div>
      {hint && (
        <div className="text-[11px] text-rose-500 mt-2">{hint}</div>
      )}
    </div>
  );
}

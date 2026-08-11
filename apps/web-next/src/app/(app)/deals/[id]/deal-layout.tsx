"use client";

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/cn";
import {
  formatCurrency,
  formatHeadlineValue,
  formatRelativeTime,
  pickHeadlineMetrics,
  toActualDollars,
  type UnitScale,
} from "@/lib/formatters";
import { comparePeriodChronologically } from "./deal-financials-period-scope";
import { STAGE_LABELS } from "@/lib/constants";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/Skeleton";
import { type DealDetail, type TeamMember, PIPELINE_STAGES, TERMINAL_STAGES } from "./deal-detail-shared";

// Minimal shape of an income-statement row needed to render the headline
// Revenue / EBITDA cards. Mirrors the public columns the API returns from
// /deals/:id/financials. Defined locally so this layout module doesn't depend
// on the larger FinancialStatement type defined alongside the chart code.
interface IncomeStatementRow {
  statementType?: string;
  period?: string;
  periodType?: string | null;
  unitScale?: UnitScale | null;
  currency?: string | null;
  lineItems?: Record<string, number | null> | null;
}

// ---------------------------------------------------------------------------
// Stage Pipeline
// ---------------------------------------------------------------------------

export function StagePipeline({
  deal,
  onStageClick,
  onChangeStage,
}: {
  deal: DealDetail;
  onStageClick: (stage: string) => void;
  onChangeStage?: () => void;
}) {
  const currentStageIndex = PIPELINE_STAGES.findIndex((s) => s.key === deal.stage);
  const isTerminal = TERMINAL_STAGES.includes(deal.stage);

  return (
    <div className="rounded-xl p-3" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)" }}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-bold text-text-main uppercase tracking-wider flex items-center gap-1.5">
          <span className="material-symbols-outlined text-primary text-xs">timeline</span>
          Deal Pipeline
        </h3>
        <button
          onClick={() => {
            if (isTerminal) return;
            if (onChangeStage) {
              onChangeStage();
            } else {
              const nextIdx = currentStageIndex + 1;
              if (nextIdx < PIPELINE_STAGES.length) {
                onStageClick(PIPELINE_STAGES[nextIdx].key);
              }
            }
          }}
          className="text-xs text-primary hover:text-blue-800 font-medium flex items-center gap-1 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">edit</span>
          Change Stage
        </button>
      </div>
      <div className="flex items-center gap-1">
        {PIPELINE_STAGES.map((stage, index) => {
          const isPast = currentStageIndex >= 0 && index < currentStageIndex;
          const isCurrent = index === currentStageIndex && !isTerminal;
          const isFuture =
            currentStageIndex < 0 || index > currentStageIndex || isTerminal;

          return (
            <div
              key={stage.key}
              className="flex-1 flex flex-col items-center relative group cursor-pointer"
              onClick={() => onStageClick(stage.key)}
            >
              <div className="flex items-center w-full">
                {index > 0 && (
                  <div
                    className={cn(
                      "flex-1 h-0.5",
                      isPast || isCurrent ? "bg-secondary" : "bg-gray-200"
                    )}
                  />
                )}
                {index === 0 && <div className="flex-1" />}
                <div
                  className={cn(
                    "size-8 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 group-hover:scale-110",
                    isPast && "bg-secondary text-white",
                    isCurrent && "bg-primary text-white ring-2 ring-primary/30 shadow-lg",
                    isFuture && !isCurrent && "border-2 border-gray-200 text-gray-400 bg-white"
                  )}
                >
                  {isPast ? (
                    <span className="material-symbols-outlined text-sm">check</span>
                  ) : (
                    <span className="material-symbols-outlined text-sm">{stage.icon}</span>
                  )}
                </div>
                {index < PIPELINE_STAGES.length - 1 ? (
                  <div
                    className={cn(
                      "flex-1 h-0.5",
                      isPast ? "bg-secondary" : "bg-gray-200"
                    )}
                  />
                ) : (
                  <div className="flex-1" />
                )}
              </div>
              <span
                className={cn(
                  "text-[10px] mt-1.5 text-center leading-tight whitespace-nowrap",
                  isPast && "text-secondary font-medium",
                  isCurrent && "text-primary font-bold",
                  isFuture && !isCurrent && "text-gray-400"
                )}
              >
                {stage.label}
              </span>
            </div>
          );
        })}
        {/* Terminal stage pill (Closed Won / Closed Lost / Passed) */}
        {isTerminal && (
          <div className="flex items-center ml-2">
            <div className="h-0.5 w-4 bg-gray-300" />
            <div
              className={cn(
                "px-2.5 py-1 rounded-full flex items-center gap-1 text-[10px] font-bold text-white shadow-md",
                deal.stage === "CLOSED_WON" && "bg-green-500",
                deal.stage === "CLOSED_LOST" && "bg-red-500",
                deal.stage === "PASSED" && "bg-gray-500"
              )}
            >
              <span className="material-symbols-outlined text-xs">
                {deal.stage === "CLOSED_WON"
                  ? "celebration"
                  : deal.stage === "CLOSED_LOST"
                    ? "cancel"
                    : "block"}
              </span>
              {STAGE_LABELS[deal.stage] || deal.stage}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deal Metadata Row (Lead Partner, Analyst, Deal Source, Last Updated)
// ---------------------------------------------------------------------------

export function DealMetadataRow({ deal }: { deal: DealDetail }) {
  const leadPartner = deal.assignedUser;
  // Team members have roles: LEAD, MEMBER, VIEWER. The first MEMBER is the analyst.
  const analyst = deal.team?.find((m) => m.role === "MEMBER") ?? deal.team?.find((m) => m.role !== "LEAD") ?? deal.team?.[0];

  return (
    <div className="grid grid-cols-4 gap-4 p-4 rounded-xl bg-background-body border border-border-subtle">
      <div>
        <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1">
          Lead Partner
        </p>
        <span className={leadPartner ? "text-[13px] text-text-main font-semibold" : "text-[13px] text-text-muted font-normal italic"}>
          {leadPartner?.name || "Not assigned"}
        </span>
      </div>
      <div>
        <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1">
          Analyst
        </p>
        <span className={analyst ? "text-[13px] text-text-main font-semibold" : "text-[13px] text-text-muted font-normal italic"}>
          {analyst?.name || "Not assigned"}
        </span>
      </div>
      <div>
        <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1">
          Deal Source
        </p>
        <span className="text-[13px] text-text-main font-semibold">
          {deal.source || "Proprietary"}
        </span>
      </div>
      <div>
        <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider mb-1">
          Last Updated
        </p>
        <span className="text-[13px] text-text-muted font-medium">
          {formatRelativeTime(deal.updatedAt)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Financial Metrics Row (Deal Size, Revenue, EBITDA, EBITDA Margin)
// ---------------------------------------------------------------------------

export function FinancialMetricsRow({ deal }: { deal: DealDetail }) {
  // Headline metrics on the deal page header. Read precedence
  // (`pickHeadlineMetrics`):
  //   1) deal.cachedRevenue / cachedEbitda / cachedEbitdaMargin — written
  //      server-side by dealCacheWriteback. Both rev and ebitda come from
  //      the SAME picked row in ACTUAL DOLLARS, so the margin is always
  //      scale-correct. cachedEbitdaMargin is precomputed.
  //   2) FinancialStatement (latest INCOME_STATEMENT) — carries unitScale +
  //      currency. Used as fallback while the cache is empty.
  //   3) Legacy deal.revenue / deal.ebitda (MILLIONS assumed). Last resort,
  //      and only the source of the historical "11103% margin" display bug
  //      because rev and ebitda were written by different paths at
  //      different scales.
  const cacheHit =
    deal.cachedRevenue != null ||
    deal.cachedEbitda != null ||
    deal.cachedEbitdaMargin != null;

  const [latestIncome, setLatestIncome] = useState<IncomeStatementRow | null>(null);
  // True while the /deals/:id/financials request is in flight. Without this,
  // the legacy `deal.revenue` / `deal.ebitda` columns render first (with a
  // possibly-wrong margin computed from MILLIONS-assumed values), then snap
  // to the in-unit FinancialStatement values once the fetch returns — visible
  // flicker on the EBITDA Margin card especially. Suppressed entirely when
  // the cache is populated since we don't need the fallback fetch.
  const [statementLoading, setStatementLoading] = useState<boolean>(
    Boolean(deal.id) && !cacheHit,
  );

  useEffect(() => {
    if (cacheHit) {
      // Cached fields fully cover Revenue / EBITDA / Margin in actual
      // dollars. Skip the fallback statement fetch entirely.
      setStatementLoading(false);
      setLatestIncome(null);
      return;
    }
    let cancelled = false;
    setStatementLoading(true);
    (async () => {
      try {
        const data = await api.get<IncomeStatementRow[]>(`/deals/${deal.id}/financials`);
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        const incomeRows = rows.filter((r) => r.statementType === "INCOME_STATEMENT");
        if (incomeRows.length === 0) {
          setLatestIncome(null);
          return;
        }
        // Prefer historical/LTM periods (skip projections). The API uses
        // HISTORICAL/PROJECTED/LTM; older snapshots may use ACTUAL.
        const historical = incomeRows.filter(
          (r) => r.periodType === "HISTORICAL" || r.periodType === "ACTUAL" || r.periodType === "LTM",
        );
        const candidates = historical.length > 0 ? historical : incomeRows;
        // comparePeriodChronologically sorts ascending; reverse to get newest.
        const sorted = [...candidates].sort((a, b) =>
          comparePeriodChronologically(b.period, a.period),
        );
        setLatestIncome(sorted[0] ?? null);
      } catch (err) {
        // Fall back to deal-level fields silently — the income statement
        // table below renders independently and surfaces its own errors.
        console.warn("[deal-layout] FinancialMetricsRow income fetch failed:", err);
        if (!cancelled) setLatestIncome(null);
      } finally {
        if (!cancelled) setStatementLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deal.id, cacheHit]);

  // Resolve revenue / EBITDA / margin via the canonical precedence helper.
  // - cached: ACTUAL DOLLARS, margin precomputed by the server.
  // - summary: latest INCOME_STATEMENT row at its native unitScale.
  // - legacy: deal.revenue / deal.ebitda assumed MILLIONS.
  const summaryShape = latestIncome
    ? {
        revenue: latestIncome.lineItems?.revenue ?? null,
        ebitda: latestIncome.lineItems?.ebitda ?? null,
        // Use the row's own ebitda_margin_pct when extracted — many rows
        // have it even when ebitda itself is null, which previously caused
        // the margin card to disappear on cache-less deals.
        ebitdaMargin: latestIncome.lineItems?.ebitda_margin_pct ?? null,
        unitScale: (latestIncome.unitScale as UnitScale | null) ?? "ACTUALS",
        currency: latestIncome.currency ?? deal.currency ?? null,
      }
    : null;
  const headline = pickHeadlineMetrics(deal, summaryShape);

  const revenueValue = headline.revenue;
  const revenueFormatted = formatHeadlineValue(headline.revenue, headline);

  const ebitdaValue = headline.ebitda;
  const ebitdaFormatted = formatHeadlineValue(headline.ebitda, headline);

  // Use the precomputed margin from the helper — when source === "cached"
  // this is the server's authoritative percentage and bypasses the
  // mismatched-units arithmetic that produced the historical 11103%
  // display bug.
  const marginPct = headline.ebitdaMargin;
  const hasMarginData = marginPct != null;

  // The revenue / EBITDA / margin cards depend on the FinancialStatement
  // fetch. Mark them so the render block can swap in a skeleton placeholder
  // until the fetch settles, instead of flashing the legacy-computed value.
  type MetricDef = {
    key: string;
    label: string;
    value: unknown;
    formatted: string;
    badge?: string;
    extra?: string;
    loading?: boolean;
  };
  const allMetrics: MetricDef[] = [
    {
      key: "revenue",
      label: "Revenue (LTM)",
      // Keep the card visible during load (so the row doesn't reflow when
      // data arrives) by treating loading as "has data".
      value: statementLoading ? "loading" : revenueValue,
      formatted: revenueFormatted,
      loading: statementLoading,
    },
    {
      key: "ebitdaMargin",
      label: "EBITDA Margin",
      // Was: `hasMarginData ? ebitdaValue : null`. With Speedy hitting the
      // legacy-margin fallthrough, marginPct = 50.1 but ebitdaValue is null
      // (summary's ebitda was null); the downstream `value != null` filter
      // then dropped the card entirely. Use marginPct as the truthy gate so
      // the card renders whenever a usable margin exists.
      value: statementLoading ? "loading" : marginPct,
      formatted: marginPct != null ? marginPct.toFixed(0) + "%" : "\u2014",
      loading: statementLoading,
    },
    {
      key: "ebitda",
      label: "EBITDA",
      value: statementLoading ? "loading" : ebitdaValue,
      formatted: ebitdaFormatted,
      loading: statementLoading,
    },
    {
      key: "dealSize",
      label: "Deal Size",
      value: deal.dealSize,
      formatted: formatCurrency(deal.dealSize, deal.currency),
      // EBITDA Multiple = dealSize / ebitda. Both must share a scale so the
      // ratio is meaningful — `deal.dealSize` is MILLIONS by convention,
      // while headline.ebitda may be ACTUALS (cached) or unitScale-tagged
      // (summary). Normalise both to actual dollars before dividing.
      extra: (() => {
        const dealSizeActual = toActualDollars(deal.dealSize, "MILLIONS");
        const ebitdaActual = toActualDollars(headline.ebitda, headline.unitScale);
        if (!dealSizeActual || !ebitdaActual) return undefined;
        return `~${(dealSizeActual / ebitdaActual).toFixed(1)}x EBITDA Multiple`;
      })(),
    },
    {
      key: "irr",
      label: "Projected IRR",
      value: deal.irrProjected,
      formatted: deal.irrProjected != null ? deal.irrProjected.toFixed(1) + "%" : "\u2014",
      badge: "Target",
      extra: deal.mom != null ? `MoM: ${deal.mom.toFixed(1)}x` : undefined,
    },
    {
      key: "mom",
      label: "Money Multiple",
      value: deal.mom,
      formatted: deal.mom != null ? deal.mom.toFixed(1) + "x" : "\u2014",
    },
  ];

  // Filter to only metrics with data
  let available = allMetrics.filter((m) => m.value != null);

  // If EBITDA + revenue both exist, prefer ebitdaMargin over raw ebitda
  const hasMargin = available.some((m) => m.key === "ebitdaMargin");
  if (hasMargin) available = available.filter((m) => m.key !== "ebitda");

  // If IRR exists, skip standalone MoM (shown as sub-text under IRR)
  const hasIRR = available.some((m) => m.key === "irr");
  if (hasIRR) available = available.filter((m) => m.key !== "mom");

  const metrics = available.slice(0, 4);

  if (metrics.length === 0) {
    return (
      <div className="col-span-full rounded-xl p-4 text-center" style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)" }}>
        <span className="material-symbols-outlined text-text-muted text-2xl mb-1 block">analytics</span>
        <p className="text-text-muted text-sm">
          No financial metrics yet. Upload a CIM or edit the deal to add data.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("grid gap-3 w-full items-stretch", metrics.length <= 2 ? "grid-cols-2" : metrics.length === 3 ? "grid-cols-3" : "grid-cols-4")}>
      {metrics.map((m) => (
        <div
          key={m.key}
          className="rounded-xl p-4 relative overflow-hidden group flex flex-col"
          style={{ background: "rgba(255, 255, 255, 0.8)", backdropFilter: "blur(8px)", border: "1px solid rgba(229, 231, 235, 0.8)", boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)" }}
        >
          <p className="text-[10px] text-text-muted font-semibold uppercase tracking-wider">{m.label}</p>
          <div className="flex items-baseline gap-2 mt-2">
            {m.loading ? (
              // Shimmer placeholder while the FinancialStatement fetch is in
              // flight. Sized to the same line-height as the formatted value
              // so the card doesn't pop when real data arrives.
              <Skeleton.Line width={84} height={20} />
            ) : (
              <span className="text-xl font-bold text-text-main leading-none tabular-nums">{m.formatted}</span>
            )}
            {!m.loading && m.badge && (
              <span className="text-[10px] font-bold text-secondary bg-secondary-light border border-secondary/20 px-1.5 py-0.5 rounded">
                {m.badge}
              </span>
            )}
          </div>
          {!m.loading && m.extra && <p className="text-[10px] text-text-muted font-medium mt-1.5">{m.extra}</p>}
          {/* Visual confidence indicators -- matches legacy mini charts.
              Suppressed during load so the mini-bar / margin bar don't render
              with stale-fallback data. Reserve the same 8px height so card
              heights stay constant between loading and loaded states. */}
          {m.loading && (m.key === "revenue" || m.key === "ebitdaMargin") && (
            <div className="h-8 mt-2 w-full" aria-hidden="true" />
          )}
          {!m.loading && m.key === "revenue" && (
            <div className="h-8 mt-2 w-full flex items-end gap-1 opacity-80">
              <div className="flex-1 bg-secondary/60 h-[40%] rounded-t-sm" />
              <div className="flex-1 bg-secondary/60 h-[50%] rounded-t-sm" />
              <div className="flex-1 bg-secondary/60 h-[45%] rounded-t-sm" />
              <div className="flex-1 bg-secondary/60 h-[60%] rounded-t-sm" />
              <div className="flex-1 bg-secondary h-[80%] rounded-t-sm" />
            </div>
          )}
          {!m.loading && m.key === "ebitdaMargin" && marginPct != null && (
            <div className="h-8 mt-2 w-full flex items-center">
              <div className="w-full h-2 bg-border-subtle rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(Math.round(marginPct), 100)}%`,
                    backgroundColor: "#003366",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Financial Statements Section
// Delegates to FinancialStatementsPanel which handles loading, empty state,
// and data rendering internally.
// ---------------------------------------------------------------------------

import { FinancialStatementsPanel } from "./deal-financials";

export function FinancialStatementsSection({ dealId, onFullscreen }: { dealId: string; onFullscreen?: () => void }) {
  return <FinancialStatementsPanel dealId={dealId} onFullscreen={onFullscreen} />;
}

// ---------------------------------------------------------------------------
// Deal Viewers ("@User on this deal") — ported from deal.js deal-viewers
// ---------------------------------------------------------------------------

export function DealViewers({ team }: { team: TeamMember[] }) {
  if (team.length === 0) return null;

  const colors = ["#003366", "#059669", "#D97706", "#7C3AED", "#DC2626"];

  const names = team
    .slice(0, 2)
    .map((m) => (m.name || "User").split(" ")[0])
    .join(", ");
  const extra = team.length > 2 ? ` +${team.length - 2}` : "";

  return (
    <div className="flex items-center gap-1.5 mt-1.5 mb-1" style={{ minHeight: 20 }}>
      <div className="flex items-center">
        {team.slice(0, 3).map((m, i) => {
          const name = m.name || "User";
          const initials = name
            .split(" ")
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();
          return (
            <div
              key={m.id || i}
              className="size-5 rounded-full flex items-center justify-center text-white text-[8px] font-bold border-2 border-white shadow-sm"
              style={{
                background: colors[i % colors.length],
                marginLeft: i > 0 ? -4 : 0,
              }}
              title={name}
            >
              {initials}
            </div>
          );
        })}
      </div>
      <span className="text-[11px] text-text-muted font-medium">
        {names}
        {extra} on this deal
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Financial Status Badge — shows "No Financials" or confidence % badge
// Ported from financials-helpers.js renderFinStatusBadge
// ---------------------------------------------------------------------------

export function FinancialStatusBadge({ dealId }: { dealId: string }) {
  const [status, setStatus] = useState<"loading" | "none" | "data">("loading");
  const [avgConfidence, setAvgConfidence] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<Array<{ extractionConfidence?: number | null }>>(`/deals/${dealId}/financials`);
        if (cancelled) return;
        const statements = Array.isArray(data) ? data : [];
        if (statements.length === 0) {
          setStatus("none");
          return;
        }
        setStatus("data");
        const confidences = statements
          .map((s) => s.extractionConfidence)
          .filter((c): c is number => c != null);
        if (confidences.length > 0) {
          setAvgConfidence(Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length));
        }
      } catch (err) {
        console.warn("[deal-layout] financials status fetch failed:", err);
        if (!cancelled) setStatus("none");
      }
    })();
    return () => { cancelled = true; };
  }, [dealId]);

  if (status === "loading") return null;

  if (status === "none") {
    return (
      <span className="px-2.5 py-0.5 rounded text-xs font-semibold border cursor-pointer transition-opacity hover:opacity-80 bg-gray-100 text-gray-500 border-gray-200">
        No Financials
      </span>
    );
  }

  // Has data -- show confidence badge
  const [cls, dotColor] =
    avgConfidence >= 80
      ? ["bg-emerald-50 text-emerald-700 border-emerald-200", "#059669"]
      : avgConfidence >= 50
        ? ["bg-amber-50 text-amber-700 border-amber-200", "#d97706"]
        : ["bg-red-50 text-red-600 border-red-200", "#dc2626"];

  return (
    <span className={cn("inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-semibold border cursor-pointer transition-opacity hover:opacity-80", cls)}>
      <span className="inline-block rounded-full" style={{ width: 5, height: 5, background: dotColor }} />
      {avgConfidence}% Confidence
    </span>
  );
}

export type ChartType = "bar" | "line" | "area" | "combo";

export type SeriesType = "bar" | "line" | "area";

export type MetricKind = "absolute" | "percent";

export type MetricSource = "P&L" | "Analysis";

export interface MetricDef {
  key: string;
  label: string;
  kind: MetricKind;
  source: MetricSource;
}

export interface GraphSeries {
  metricKey: string;
  seriesType: SeriesType;
  color: string;
}

// Phase 2: graphs are persisted server-side and deal-scoped. The shape mirrors
// the row returned by the API (`GET /deals/:dealId/graphs`, `POST/PATCH` mutations).
export interface Graph {
  id: string;
  dealId: string;
  organizationId: string;
  createdById: string | null;
  title: string;
  chartType: ChartType;
  series: GraphSeries[];
  createdAt: string;
  updatedAt: string;
}

// The cross-deal `GET /graphs` endpoint embeds a small `deal` summary on each
// row so the firm-wide gallery can show which deal each graph belongs to without
// a second round-trip.
export interface GraphWithDeal extends Graph {
  deal: {
    id: string;
    projectName: string | null;
    target: string | null;
  };
}

// Payload accepted by `POST /deals/:dealId/graphs` and `PATCH /graphs/:graphId`.
// All server-managed fields (id, dealId, createdAt, …) are omitted.
export interface GraphDraft {
  title: string;
  chartType: ChartType;
  series: GraphSeries[];
}

// Returned by `GET /deals/:dealId/financials/timeseries`. Numeric fields are
// optional — a deal with no income statements yet returns `[]` and even rows
// that exist may be missing some lines/ratios depending on what was extracted.
// The index signature is required by ChartRenderer so it can pull metrics out
// by string key without TS complaints.
export interface FinancialRow {
  period: string;
  revenue?: number;
  cogs?: number;
  grossProfit?: number;
  opex?: number;
  ebitda?: number;
  netIncome?: number;
  grossMargin?: number;
  ebitdaMargin?: number;
  netMargin?: number;
  [key: string]: string | number | undefined;
}

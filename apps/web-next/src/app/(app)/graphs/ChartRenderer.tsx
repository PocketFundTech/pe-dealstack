"use client";

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CURRENCY_LABEL, METRIC_CATALOG, PALETTE } from "./constants";
import type { FinancialRow, Graph } from "./types";

interface ChartRendererProps {
  graph: Pick<Graph, "chartType" | "series">;
  data: FinancialRow[];
  compact?: boolean;
}

export function ChartRenderer({ graph, data, compact = false }: ChartRendererProps) {
  const seriesMetas = graph.series.map((s) => ({
    ...s,
    meta: METRIC_CATALOG.find((m) => m.key === s.metricKey),
  }));

  const hasPercent = seriesMetas.some((s) => s.meta?.kind === "percent");
  const hasAbsolute = seriesMetas.some((s) => s.meta?.kind === "absolute");

  const axisTick = { fontSize: compact ? 10 : 11, fill: "#475569" };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={data}
        margin={{ top: 10, right: hasPercent ? 12 : 16, left: 0, bottom: compact ? 0 : 8 }}
      >
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="period"
          tick={axisTick}
          tickLine={false}
          axisLine={{ stroke: "#cbd5e1" }}
          interval={compact ? 2 : 0}
          angle={compact ? 0 : -25}
          textAnchor={compact ? "middle" : "end"}
          height={compact ? 24 : 56}
        />
        {hasAbsolute && (
          <YAxis
            yAxisId="left"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
            tickFormatter={(v) => `${v}`}
            width={compact ? 32 : 48}
            label={
              compact
                ? undefined
                : {
                    value: CURRENCY_LABEL,
                    angle: -90,
                    position: "insideLeft",
                    offset: 10,
                    fill: "#64748b",
                    fontSize: 11,
                  }
            }
          />
        )}
        {hasPercent && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: "#cbd5e1" }}
            tickFormatter={(v) => `${v}%`}
            width={compact ? 32 : 44}
            label={
              compact
                ? undefined
                : {
                    value: "%",
                    angle: 90,
                    position: "insideRight",
                    offset: 10,
                    fill: "#64748b",
                    fontSize: 11,
                  }
            }
          />
        )}
        {!compact && (
          <Tooltip
            cursor={{ fill: "rgba(15,23,42,0.04)" }}
            contentStyle={{
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              fontSize: 12,
              boxShadow: "0 4px 16px rgba(15,23,42,0.08)",
            }}
            formatter={(value, name) => {
              const meta = METRIC_CATALOG.find((m) => m.label === name);
              if (meta?.kind === "percent") return [`${value}%`, name];
              return [`${CURRENCY_LABEL} ${value}`, name];
            }}
          />
        )}
        {!compact && (
          <Legend
            verticalAlign="top"
            height={28}
            iconType="circle"
            wrapperStyle={{ fontSize: 12, color: "#334155" }}
          />
        )}

        {seriesMetas.map((s, idx) => {
          if (!s.meta) return null;
          const axisId = s.meta.kind === "percent" ? "right" : "left";
          const type =
            graph.chartType === "combo" ? s.seriesType || "bar" : graph.chartType;
          const color = s.color || PALETTE[idx % PALETTE.length];
          const common = { yAxisId: axisId, dataKey: s.metricKey, name: s.meta.label };

          if (type === "bar") {
            return (
              <Bar
                key={s.metricKey}
                {...common}
                fill={color}
                radius={[3, 3, 0, 0]}
                barSize={compact ? 6 : 18}
              />
            );
          }
          if (type === "line") {
            return (
              <Line
                key={s.metricKey}
                {...common}
                type="monotone"
                stroke={color}
                strokeWidth={compact ? 1.5 : 2.25}
                dot={compact ? false : { r: 2.5, strokeWidth: 0, fill: color }}
                activeDot={{ r: 4 }}
              />
            );
          }
          if (type === "area") {
            return (
              <Area
                key={s.metricKey}
                {...common}
                type="monotone"
                stroke={color}
                strokeWidth={compact ? 1.25 : 2}
                fill={color}
                fillOpacity={0.18}
              />
            );
          }
          return null;
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

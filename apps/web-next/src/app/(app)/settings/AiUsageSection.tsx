"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface UsageBreakdownEntry {
  operation: string;
  count: number;
  credits: number;
}

interface UsageMeResponse {
  totalCredits: number;
  breakdown: UsageBreakdownEntry[];
  monthStart: string;
}

// Visual reference for the progress bar — no enforced quota during beta.
// Pure shape indicator: helps the user feel their relative usage without
// implying a cap. Tune later if we introduce real limits.
const SOFT_REFERENCE_CREDITS = 1000;

function humanizeOperation(op: string): string {
  return op
    .replace(/_/g, " ")
    .replace(/\./g, " · ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AiUsageSection() {
  const [data, setData] = useState<UsageMeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<UsageMeResponse>("/usage/me");
        if (!cancelled) setData(res);
      } catch (err) {
        // Non-fatal — user just doesn't see their usage if the endpoint
        // is unreachable. Log so we notice in dev / Sentry.
        console.warn("[AiUsageSection] failed to load /usage/me:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const total = data?.totalCredits ?? 0;
  const breakdown = data?.breakdown ?? [];
  const fillPct = Math.min(100, (total / SOFT_REFERENCE_CREDITS) * 100);

  return (
    <section
      id="section-ai-usage"
      className="bg-white rounded-xl border border-border-subtle shadow-sm overflow-hidden"
    >
      <div className="p-6 border-b border-border-subtle">
        <h3 className="text-lg font-bold text-text-main">AI Usage</h3>
        <p className="text-sm text-text-secondary mt-1">
          Free during beta. Tracking helps us understand how Avise is used.
        </p>
      </div>

      <div className="p-6">
        {loading ? (
          <div className="text-text-secondary py-4">Loading…</div>
        ) : (
          <>
            <div className="flex items-baseline gap-2 mb-2">
              <div
                className="text-4xl font-bold"
                style={{ color: "#003366" }}
                data-testid="ai-usage-total"
              >
                {total.toLocaleString()}
              </div>
              <div className="text-sm text-text-secondary">credits used this month</div>
            </div>

            <div className="bg-gray-100 rounded-full h-2 overflow-hidden mb-6">
              <div
                className="h-full transition-all duration-300"
                style={{ backgroundColor: "#003366", width: `${fillPct}%` }}
              />
            </div>

            {breakdown.length === 0 ? (
              <div className="text-sm text-text-secondary italic py-4">
                No AI activity yet this month.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-text-secondary border-b border-border-subtle">
                    <th className="py-2">Operation</th>
                    <th className="py-2 text-right">Count</th>
                    <th className="py-2 text-right">Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((b) => (
                    <tr
                      key={b.operation}
                      className="border-b border-border-subtle/40"
                    >
                      <td className="py-2">{humanizeOperation(b.operation)}</td>
                      <td className="py-2 text-right">{b.count}</td>
                      <td className="py-2 text-right">{b.credits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </section>
  );
}

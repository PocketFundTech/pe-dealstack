"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { SignalResults } from "../dashboard-modals";
import { WidgetShell } from "./shell";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Portfolio Signal Monitor widget                                         */
/*                                                                          */
/*  Optional dashboard widget that re-homes the portfolio-signals feature.  */
/*  Calls POST /ai/scan-signals and renders the results via the shared      */
/*  SignalResults component. Distinct from AiDealSignalsWidget, which is    */
/*  the Gmail inbox deal finder. Owns its own scanning/result/error state.  */
/* ──────────────────────────────────────────────────────────────────────── */

// Returned by POST /ai/scan-signals — mirrors the shape SignalResults renders.
type PortfolioSignalsResult = {
  signals?: Array<{
    title: string;
    description: string;
    severity: string;
    signalType: string;
    dealName: string;
    suggestedAction: string;
  }>;
  processedCount?: number;
};

export function PortfolioSignalsWidget() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<PortfolioSignalsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setResult(null);
    setError(null);
    try {
      // POST, not GET: the route is `router.post('/ai/scan-signals')`.
      // The widget shipped calling GET, so every scan 404'd and the
      // feature looked broken/unbuilt (found 2026-08-18 — the backend
      // has been returning real signals the whole time).
      const res = await api.post<PortfolioSignalsResult>("/ai/scan-signals", {});
      setResult(res);
    } catch (err) {
      console.warn("[dashboard] scan-signals failed:", err);
      setError("Couldn't scan portfolio signals — please try again.");
      setTimeout(() => setError(null), 5000);
    } finally {
      setScanning(false);
    }
  };

  return (
    <WidgetShell
      title="Portfolio Signals"
      headerRight={
        <button
          type="button"
          onClick={scan}
          disabled={scanning}
          className="dash-btn-ghost shrink-0 whitespace-nowrap flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
        >
          <span className={cn("material-symbols-outlined text-[16px]", scanning && "animate-spin")}>{scanning ? "progress_activity" : "radar"}</span>
          {scanning ? "Scanning…" : "Scan signals"}
        </button>
      }
    >
      {error && (
        <p className="px-5 py-2 text-xs text-(--dash-red) bg-(--dash-red-wash) border-b border-(--dash-rule) flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {scanning ? (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2)">Reading your active deals for risks and opportunities…</p>
      ) : result ? (
        <SignalResults result={result} />
      ) : (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2) max-w-[52ch]">
          Surfaces AI-detected risks and opportunities across your active deals, each with a suggested next step.
        </p>
      )}
    </WidgetShell>
  );
}

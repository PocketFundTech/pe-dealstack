"use client";

import { useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DealScorecard } from "@/types";

const REASON_ICONS: Record<DealScorecard["reasons"][number]["kind"], { icon: string; cls: string }> = {
  hit: { icon: "check_circle", cls: "text-green-600" },
  miss: { icon: "cancel", cls: "text-red-500" },
  flag: { icon: "flag", cls: "text-amber-600" },
};

export function DealScorecardSection({
  dealId,
  initialScorecard,
}: {
  dealId: string;
  initialScorecard?: DealScorecard | null;
}) {
  const [scorecard, setScorecard] = useState<DealScorecard | null>(initialScorecard ?? null);
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCriteria, setNeedsCriteria] = useState(false);

  const runScore = async () => {
    setScoring(true);
    setError(null);
    setNeedsCriteria(false);
    try {
      const result = await api.post<DealScorecard>(`/deals/${dealId}/scorecard`, {});
      setScorecard(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CRITERIA_NOT_CONFIGURED") {
        setNeedsCriteria(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to score deal");
      }
    } finally {
      setScoring(false);
    }
  };

  return (
    <div className="bg-background-body rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px] text-[#003366]">grading</span>
          <span className="text-xs font-bold uppercase tracking-wider text-text-muted">Deal Scorecard</span>
        </div>
        <button
          onClick={runScore}
          disabled={scoring}
          className="px-3 py-1.5 rounded-md text-xs font-semibold text-white disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          {scoring ? "Scoring..." : scorecard ? "Re-score" : "Score deal"}
        </button>
      </div>

      {needsCriteria && (
        <p className="text-xs text-text-secondary">
          Set your investment criteria first —{" "}
          <Link href="/settings#criteria" className="text-[#003366] font-semibold underline">
            open Settings
          </Link>
          .
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}

      {scorecard && (
        <div className="mt-1">
          <div className="flex items-center gap-4 mb-3">
            <span
              className={cn(
                "px-3 py-1.5 rounded-md border text-sm font-bold",
                scorecard.verdict === "GO" && "bg-green-50 border-green-200 text-green-700",
                scorecard.verdict === "NO_GO" && "bg-red-50 border-red-200 text-red-600",
                scorecard.verdict === "BORDERLINE" && "bg-amber-50 border-amber-200 text-amber-700",
              )}
            >
              {scorecard.verdict.replace("_", "-")} · {scorecard.overallScore}/100
            </span>
            <div className="text-xs text-text-muted">
              <div>Quality: <span className="font-semibold text-text-main">{scorecard.qualityScore}</span></div>
              <div>Thesis fit: <span className="font-semibold text-text-main">{scorecard.thesisFitScore}</span></div>
            </div>
          </div>
          <ul className="space-y-1">
            {scorecard.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-text-secondary">
                <span className={cn("material-symbols-outlined text-[16px] shrink-0", REASON_ICONS[r.kind].cls)}>
                  {REASON_ICONS[r.kind].icon}
                </span>
                {r.text}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-text-muted mt-2">
            Scored {new Date(scorecard.scoredAt).toLocaleString()}
          </p>
        </div>
      )}
    </div>
  );
}

import { cn } from "@/lib/cn";
import type { DealScorecard } from "@/types";

const VERDICT_STYLES: Record<DealScorecard["verdict"], { label: string; cls: string }> = {
  GO: { label: "GO", cls: "bg-green-50 border-green-200 text-green-700" },
  NO_GO: { label: "NO-GO", cls: "bg-red-50 border-red-200 text-red-600" },
  BORDERLINE: { label: "", cls: "bg-amber-50 border-amber-200 text-amber-700" },
};

export function ScorecardBadge({ scorecard }: { scorecard?: DealScorecard | null }) {
  if (!scorecard) return null;
  const v = VERDICT_STYLES[scorecard.verdict];
  return (
    <span
      className={cn(
        "px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap leading-none",
        v.cls,
      )}
      title={`Scorecard: quality ${scorecard.qualityScore}, thesis fit ${scorecard.thesisFitScore}`}
    >
      {v.label ? `${v.label} ${scorecard.overallScore}` : `${scorecard.overallScore}`}
    </span>
  );
}

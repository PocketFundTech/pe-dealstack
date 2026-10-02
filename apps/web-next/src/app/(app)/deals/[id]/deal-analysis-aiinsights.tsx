"use client";

import {
  type AnalysisData,
  type NarrativeInsights,
  BANKER_BLUE,
  BANKER_BLUE_LIGHT,
  BANKER_BLUE_MUTED,
  AI_INSIGHT_SECTIONS,
} from "./deal-analysis-types";
import {
  AnalysisCard,
  CardHeader,
  EmptyTabState,
} from "./deal-analysis-shared";

// ---------------------------------------------------------------------------
// AI Insights Tab (matches legacy renderAIInsightsTab — id "aiinsights")
//   Sub-sections must be in this exact order, with these exact titles
//   and Material Symbol icons (see AI_INSIGHT_SECTIONS in deal-analysis-types):
//     - Executive Summary       (summarize)
//     - Key Strengths           (thumb_up)
//     - Key Risks               (warning)
//     - Investment Thesis       (lightbulb)
//     - Due Diligence Priorities (checklist)
// ---------------------------------------------------------------------------

export function AIInsightsPanel({
  insights, error = null, onRetry,
}: {
  insights: NarrativeInsights | null;
  /** Why generation failed (out of credit, bad AI answer…). Set → no "Loading…". */
  error?: string | null;
  onRetry?: () => void;
}) {
  if (!insights && error) {
    return (
      <AnalysisCard className="text-center">
        <span className="material-symbols-outlined text-[40px] text-red-300 block mb-3">error_outline</span>
        <h3 className="text-sm font-semibold text-gray-600 mb-1.5">AI insights unavailable</h3>
        <p className="text-xs text-gray-500 leading-relaxed max-w-sm mx-auto" role="alert">{error}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-4 text-xs font-semibold text-white px-4 py-2 rounded-lg"
            style={{ backgroundColor: BANKER_BLUE }}
          >
            Retry
          </button>
        )}
      </AnalysisCard>
    );
  }

  if (!insights) {
    return (
      <AnalysisCard className="text-center" >
        <span className="material-symbols-outlined text-[40px] text-gray-400 block mb-3">auto_awesome</span>
        <h3 className="text-sm font-semibold text-gray-500 mb-1.5">AI Insights Loading...</h3>
        <p className="text-xs text-gray-400 leading-relaxed">
          Narrative insights are generated asynchronously.<br />
          Refresh in a few seconds to see AI-powered analysis.
        </p>
      </AnalysisCard>
    );
  }

  const rendered = AI_INSIGHT_SECTIONS.filter((s) => insights[s.key]);
  if (!rendered.length) {
    return <EmptyTabState icon="auto_awesome" message="AI insights not available for this deal yet." />;
  }

  return (
    <div className="flex flex-col gap-4">
      {rendered.map((s) => {
        const content = insights[s.key];
        const isList = Array.isArray(content);
        return (
          <AnalysisCard key={s.key}>
            <CardHeader icon={s.icon} title={s.title} />
            {isList ? (
              <ul className="text-xs text-gray-700 pl-5 m-0 list-disc">
                {(content as string[]).map((item, i) => (
                  <li key={i} className="mb-1.5 leading-relaxed">{item}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-700 leading-relaxed m-0">{content as string}</p>
            )}
          </AnalysisCard>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memo Tab (matches legacy renderMemoTab — id "memo")
//   Heading copy is canonical: "Investment Memo Ready" / "Generate Investment Memo"
// ---------------------------------------------------------------------------

export function MemoPanel({ analysis, dealId }: { analysis: AnalysisData | null; dealId: string }) {
  const qoeScore = analysis?.qoe?.score;
  // analysis.memo isn't yet wired in web-next — treat as not-yet-generated.
  const hasMemo = false;

  return (
    <AnalysisCard className="text-center">
      <div className="flex justify-center mb-4">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center"
          style={{ background: `linear-gradient(135deg, ${BANKER_BLUE_MUTED}, #D6DEE8)` }}
        >
          <span className="material-symbols-outlined text-[32px]" style={{ color: BANKER_BLUE }}>description</span>
        </div>
      </div>
      <h3 className="text-base font-bold text-gray-900 mb-1.5">
        {hasMemo ? "Investment Memo Ready" : "Generate Investment Memo"}
      </h3>
      <p className="text-xs text-gray-500 mb-1 leading-relaxed">
        {hasMemo
          ? "Auto-generated memo based on extracted financials."
          : "Extract financial data first to auto-generate an investment memorandum."}
      </p>
      {qoeScore != null && (
        <span
          className="inline-flex text-[10px] font-semibold px-2.5 py-0.5 rounded-full mt-2"
          style={{ background: BANKER_BLUE_MUTED, color: BANKER_BLUE }}
        >
          QoE Score: {qoeScore}/100
        </span>
      )}
      <div className="mt-5">
        <a
          href={`/memo-builder?dealId=${dealId}`}
          className="inline-flex items-center gap-2 px-7 py-3 text-[13px] font-bold text-white rounded-[10px] no-underline shadow-[0_2px_8px_rgba(0,51,102,0.25)] hover:shadow-[0_4px_16px_rgba(0,51,102,0.35)] hover:-translate-y-px transition-all"
          style={{ background: `linear-gradient(135deg, ${BANKER_BLUE}, ${BANKER_BLUE_LIGHT})` }}
        >
          <span className="material-symbols-outlined text-[18px]">edit_document</span>
          Open Memo Builder
        </a>
      </div>
    </AnalysisCard>
  );
}

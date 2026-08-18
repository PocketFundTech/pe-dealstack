"use client";

// Clause-by-clause report for an incoming counterparty NDA.
//
// Design intent: a partner should know in ten seconds whether to push back,
// and be able to paste replacement language without opening Word. So the
// worst findings sort to the top, ACCEPTABLE ones collapse away, and every
// suggestion has a Copy button.
//
// The "unverified quote" warning is deliberately prominent. A quote that
// failed the verbatim check may be the model's paraphrase — showing it as
// if it were contract text would be the exact failure this feature exists
// to avoid.

import { useState } from "react";

export interface NdaFinding {
  clauseKey: string;
  clauseTitle: string;
  status: "MISSING" | "ACCEPTABLE" | "DEVIATION" | "DEAL_BREAKER";
  severity: "LOW" | "MEDIUM" | "HIGH";
  quotedText: string;
  whyItMatters: string;
  playbookPosition: string;
  suggestedLanguage: string;
  quoteVerified: boolean;
}

export interface NdaReviewPayload {
  id?: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  summary: string;
  findings: NdaFinding[];
  model?: string;
  reviewedAt?: string;
  sourceFileName?: string;
}

const STATUS_STYLE: Record<NdaFinding["status"], { chip: string; label: string }> = {
  DEAL_BREAKER: { chip: "bg-red-50 text-red-700 border-red-200", label: "Deal-breaker" },
  DEVIATION: { chip: "bg-amber-50 text-amber-700 border-amber-200", label: "Deviates" },
  MISSING: { chip: "bg-slate-100 text-slate-600 border-slate-200", label: "Missing" },
  ACCEPTABLE: { chip: "bg-green-50 text-green-700 border-green-200", label: "Acceptable" },
};

const RISK_STYLE: Record<NdaReviewPayload["riskLevel"], string> = {
  HIGH: "bg-red-50 text-red-700 border-red-200",
  MEDIUM: "bg-amber-50 text-amber-700 border-amber-200",
  LOW: "bg-green-50 text-green-700 border-green-200",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
    >
      <span className="material-symbols-outlined text-[14px]">
        {copied ? "check" : "content_copy"}
      </span>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function FindingCard({ finding }: { finding: NdaFinding }) {
  const style = STATUS_STYLE[finding.status];
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-slate-900">{finding.clauseTitle}</h4>
          <p className="mt-0.5 text-xs text-slate-500">{finding.whyItMatters}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${style.chip}`}>
          {style.label}
        </span>
      </div>

      {finding.quotedText && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Their language
          </p>
          {finding.quoteVerified ? (
            <blockquote className="border-l-2 border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs leading-relaxed text-slate-700">
              {finding.quotedText}
            </blockquote>
          ) : (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                <span className="material-symbols-outlined text-[15px]">warning</span>
                Quote could not be matched to the document
              </p>
              <p className="mt-1 text-xs text-amber-700">
                We hide language we can&rsquo;t find verbatim in your file. Check this clause in the
                original before relying on it.
              </p>
            </div>
          )}
        </div>
      )}

      {finding.status !== "ACCEPTABLE" && finding.playbookPosition && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
            Your position
          </p>
          <p className="text-xs text-slate-600">{finding.playbookPosition}</p>
        </div>
      )}

      {finding.suggestedLanguage && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
              Suggested replacement
            </p>
            <CopyButton text={finding.suggestedLanguage} />
          </div>
          <p className="rounded border border-slate-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-slate-700">
            {finding.suggestedLanguage}
          </p>
        </div>
      )}
    </li>
  );
}

export function NdaReviewReport({
  review,
  onBack,
  onEditPlaybook,
}: {
  review: NdaReviewPayload;
  onBack: () => void;
  onEditPlaybook?: () => void;
}) {
  const [showAcceptable, setShowAcceptable] = useState(false);

  const actionable = review.findings.filter((f) => f.status !== "ACCEPTABLE");
  const acceptable = review.findings.filter((f) => f.status === "ACCEPTABLE");
  const dealBreakers = actionable.filter((f) => f.status === "DEAL_BREAKER").length;
  const unverified = review.findings.filter((f) => f.quotedText && !f.quoteVerified).length;

  return (
    <div className="mx-auto w-full max-w-[820px] px-6 py-8">
      <button
        onClick={onBack}
        className="mb-5 flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900"
      >
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to NDAs
      </button>

      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${RISK_STYLE[review.riskLevel]}`}>
                {review.riskLevel} risk
              </span>
              {dealBreakers > 0 && (
                <span className="text-xs font-medium text-red-700">
                  {dealBreakers} deal-breaker{dealBreakers === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <h2 className="mt-2 truncate text-lg font-semibold text-slate-900">
              {review.sourceFileName || "NDA review"}
            </h2>
            <p className="mt-1 text-sm text-slate-600">{review.summary}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
          <span>{review.findings.length} clauses reviewed</span>
          {unverified > 0 && (
            <span className="text-amber-700">{unverified} quote(s) unmatched</span>
          )}
          {onEditPlaybook && (
            <button onClick={onEditPlaybook} className="ml-auto font-medium text-[#003366] hover:underline">
              Edit playbook
            </button>
          )}
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {actionable.map((f) => (
          <FindingCard key={`${f.clauseKey}-${f.clauseTitle}`} finding={f} />
        ))}
      </ul>

      {acceptable.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowAcceptable((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            <span className="material-symbols-outlined text-[18px]">
              {showAcceptable ? "expand_more" : "chevron_right"}
            </span>
            {acceptable.length} clause{acceptable.length === 1 ? "" : "s"} match your playbook
          </button>
          {showAcceptable && (
            <ul className="mt-3 flex flex-col gap-3">
              {acceptable.map((f) => (
                <FindingCard key={`${f.clauseKey}-${f.clauseTitle}`} finding={f} />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-6 text-center text-xs text-slate-400">
        Commercial review to speed up your redline — not legal advice.
      </p>
    </div>
  );
}

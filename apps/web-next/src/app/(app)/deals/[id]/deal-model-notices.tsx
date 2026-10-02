"use client";

// Plain-language reasons for what the Build model panel can't show
// (fix plan G7). Each case used to be a silent blank or "—".

import type { ModelStructure } from "./deal-model-types";

interface ReturnsFigures {
  equity: number;
  exitEquity: number;
  irr: number | null;
  mom: number | null;
}

/** Why IRR / MoM show "—" for the active case, or null when both are computed. */
export function returnsGapReason(p: ReturnsFigures): string | null {
  if (p.irr !== null && p.mom !== null) return null;
  if (p.equity <= 0) {
    return "IRR and MoM can't be calculated: the equity cheque is zero or negative because the new debt covers the whole purchase. Lower the debt so the sponsor puts in equity.";
  }
  if (p.exitEquity <= 0) {
    return "IRR can't be calculated: at exit the equity is worth nothing in this case (the exit value doesn't cover the remaining debt).";
  }
  return null;
}

/** Why entry EV / IRR / MoM are missing, from the base column's entry source. */
export function entryNotice(model: ModelStructure): { tone: "warn" | "info"; text: string } | null {
  const source = model.base?.entrySource;
  if (!model.base) return null;
  if (source === "missing") {
    return {
      tone: "warn",
      text:
        `No EBITDA was found or derived for the base period (${model.base.label}), so entry value, debt, IRR and MoM can't be calculated. ` +
        "Re-extract a P&L that shows EBITDA (or its cost lines), or add EBITDA to the deal record and the model will use it as entry EBITDA.",
    };
  }
  if (source === "deal") {
    return {
      tone: "info",
      text: `The statements have no EBITDA for ${model.base.label}, so entry EBITDA is the deal record's figure. Check it before relying on the returns.`,
    };
  }
  return null;
}

export function NoticeBar({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const styles = tone === "warn"
    ? "border-amber-200 bg-amber-50 text-amber-900"
    : "border-blue-100 bg-blue-50 text-[#003366]";
  return (
    <div className={`flex gap-2 border-b px-5 py-3 text-xs ${styles}`} role="note">
      {tone === "warn"
        ? <span className="material-symbols-outlined text-[18px]">warning</span>
        : <span className="material-symbols-outlined text-[18px]">info</span>}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

/** Expected empty state (no financials yet) — not an error. */
export function NoFinancialsState() {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle px-6 py-8 text-center">
      <span className="material-symbols-outlined text-2xl text-text-muted">table_chart</span>
      <p className="mt-2 text-sm font-medium text-text-main">No model yet</p>
      <p className="mt-1 text-xs text-text-muted">
        This deal has no extracted financial statements. Extract them under Financial Statements above and the model builds from them.
      </p>
    </div>
  );
}

/** The model inputs failed to load — a real failure, with the reason and a retry. */
export function LoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/40 px-6 py-8 text-center">
      <span className="material-symbols-outlined text-2xl text-red-400">error_outline</span>
      <p className="mt-2 text-sm font-medium text-text-main">Couldn&apos;t load the model</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-text-secondary" role="alert">{message}</p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-lg px-4 py-2 text-xs font-semibold text-white"
        style={{ backgroundColor: "#003366" }}
      >
        Retry
      </button>
    </div>
  );
}

"use client";

export interface ConflictVersion {
  id: string;
  documentId: string;
  documentName: string;
  isActive: boolean;
  lineItems: Record<string, number | null>;
  /** Original unit scale of this version's source document. */
  unitScale?: "ACTUALS" | "THOUSANDS" | "MILLIONS" | "BILLIONS" | null;
  /** ISO currency code, defaults to USD on the server. */
  currency?: string | null;
  extractionConfidence: number;
  extractionSource: string;
  extractedAt: string;
  reviewedAt: string | null;
}

export interface ConflictGroup {
  statementType: string;
  period: string;
  versions: ConflictVersion[];
}

interface ConflictBannerProps {
  conflicts: ConflictGroup[];
  onAutoResolve: () => void;
}

export function ConflictBanner({ conflicts, onAutoResolve }: ConflictBannerProps) {
  if (conflicts.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border-2 border-blue-300 bg-blue-50 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
        <span className="material-symbols-outlined text-blue-600 text-lg">merge_type</span>
        <div className="flex-1 min-w-[200px]">
          <span className="text-xs font-bold text-blue-900">
            {conflicts.length} Overlapping Period{conflicts.length > 1 ? "s" : ""} Found
          </span>
          <span className="text-[10px] text-blue-600 ml-2">
            Multiple documents extracted data for the same period — highest-confidence version is shown
          </span>
        </div>
        <button
          onClick={onAutoResolve}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-300 rounded-md hover:bg-blue-100 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">auto_fix_high</span>
          Auto-resolve
        </button>
      </div>

      {/* Conflict detail rows */}
      <div className="border-t border-blue-200/60 px-4 py-2 space-y-1">
        {conflicts.map((c) => (
          <div key={`${c.statementType}|${c.period}`} className="flex items-center gap-2 text-[10px] text-blue-700">
            <span className="material-symbols-outlined text-[11px] text-blue-400">chevron_right</span>
            <span className="font-semibold">{c.statementType.replace(/_/g, " ")}</span>
            <span>{c.period}</span>
            <span className="text-blue-400">·</span>
            <span>{c.versions.length} versions</span>
            <span className="text-blue-400 ml-auto">
              Showing: {c.versions.reduce((best, v) =>
                v.extractionConfidence > best.extractionConfidence ? v : best
              ).documentName}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

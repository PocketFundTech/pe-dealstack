"use client";

import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/formatters";
import { createClient } from "@/lib/supabase/client";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DealOption {
  id: string;
  name: string;
}

export interface ExtractionField {
  value: string | number | null;
  confidence: number;
  source?: string;
}

export interface ExtractionResult {
  companyName?: ExtractionField;
  industry?: ExtractionField;
  revenue?: ExtractionField;
  ebitda?: ExtractionField;
  overallConfidence?: number;
  needsReview?: boolean;
  reviewReasons?: string[];
  currency?: string;
  summary?: string;
  keyRisks?: string[];
  investmentHighlights?: string[];
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  reason: string;
  type: "choice" | "text";
  options?: string[];
  placeholder?: string;
}

export interface IngestResponse {
  deal?: { id: string; name: string };
  extraction?: ExtractionResult;
  isUpdate?: boolean;
  summary?: { imported: number; failed: number; total: number };
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export const TABS = [
  { key: "file", label: "Upload File", icon: "upload_file" },
  { key: "text", label: "Paste Text", icon: "edit_note" },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

export const TEXT_SOURCE_TYPES = [
  { value: "other", label: "Source: Other" },
  { value: "email", label: "Email" },
  { value: "note", label: "Note" },
  { value: "slack", label: "Slack" },
  { value: "whatsapp", label: "WhatsApp" },
];

/* ------------------------------------------------------------------ */
/*  Helper: raw authed fetch (for FormData — no JSON content-type)     */
/* ------------------------------------------------------------------ */

const API_BASE_URL = "/api";

export async function authFetchRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const supabase = createClient();
  // Validate user first (same pattern as the shared api client)
  const { error } = await supabase.auth.getUser();
  if (error) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers: HeadersInit = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  return res;
}

/* ------------------------------------------------------------------ */
/*  DealSelector                                                       */
/* ------------------------------------------------------------------ */

interface DealSelectorProps {
  mode: "new" | "existing";
  setMode: (m: "new" | "existing") => void;
  selectedDeal: DealOption | null;
  setSelectedDeal: (d: DealOption | null) => void;
  dealSearch: string;
  setDealSearch: (s: string) => void;
  dealOptions: DealOption[];
  loadingDeals: boolean;
  showDealDropdown: boolean;
  setShowDealDropdown: (v: boolean) => void;
}

export function DealSelector({
  mode,
  setMode,
  selectedDeal,
  setSelectedDeal,
  dealSearch,
  setDealSearch,
  dealOptions,
  loadingDeals,
  showDealDropdown,
  setShowDealDropdown,
}: DealSelectorProps) {
  return (
    <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card p-5">
      <label className="block text-sm font-medium text-text-main mb-3">Target</label>
      <div className="flex gap-3 mb-4">
        <button
          onClick={() => { setMode("new"); setSelectedDeal(null); }}
          className={cn(
            "flex-1 flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all",
            mode === "new"
              ? "border-primary bg-blue-50 text-primary"
              : "border-border-subtle bg-background-body text-text-secondary hover:border-primary/30"
          )}
        >
          <span className="material-symbols-outlined text-[18px]">add_circle</span>
          Create New Deal
        </button>
        <button
          onClick={() => setMode("existing")}
          className={cn(
            "flex-1 flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all",
            mode === "existing"
              ? "border-primary bg-blue-50 text-primary"
              : "border-border-subtle bg-background-body text-text-secondary hover:border-primary/30"
          )}
        >
          <span className="material-symbols-outlined text-[18px]">update</span>
          Update Existing Deal
        </button>
      </div>

      {/* Deal search (existing mode) */}
      {mode === "existing" && (
        <div className="relative" data-deal-dropdown>
          <label className="block text-xs font-medium text-text-muted mb-1">Select Deal</label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <span className="material-symbols-outlined text-text-muted text-[16px]">search</span>
            </div>
            <input
              type="text"
              value={selectedDeal ? selectedDeal.name : dealSearch}
              onChange={(e) => {
                setDealSearch(e.target.value);
                setSelectedDeal(null);
                setShowDealDropdown(true);
              }}
              onFocus={() => setShowDealDropdown(true)}
              className="w-full rounded-lg border border-border-subtle bg-background-body py-2 pl-9 pr-3 text-sm text-text-main placeholder-text-muted focus:ring-2 focus:ring-primary/20 focus:border-primary"
              placeholder="Search deals by name..."
            />
            {selectedDeal && (
              <button
                onClick={() => { setSelectedDeal(null); setDealSearch(""); }}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            )}
          </div>

          {/* Dropdown */}
          {showDealDropdown && !selectedDeal && (
            <div className="absolute z-20 mt-1 w-full bg-surface-card border border-border-subtle rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {loadingDeals ? (
                <div className="flex items-center justify-center py-4">
                  <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
                </div>
              ) : dealOptions.length === 0 ? (
                <div className="px-4 py-3 text-xs text-text-muted text-center">
                  {dealSearch.length < 2 ? "Type to search deals..." : "No deals found"}
                </div>
              ) : (
                dealOptions.map((deal) => (
                  <button
                    key={deal.id}
                    onClick={() => {
                      setSelectedDeal(deal);
                      setDealSearch("");
                      setShowDealDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2.5 text-sm text-text-main hover:bg-background-body transition-colors border-b border-border-subtle last:border-0"
                  >
                    {deal.name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResultDisplay                                                       */
/* ------------------------------------------------------------------ */

function ResultField({
  label,
  value,
  confidence,
  source,
}: {
  label: string;
  value: string;
  confidence?: number;
  source?: string;
}) {
  const barColor =
    confidence !== undefined
      ? confidence >= 80
        ? "bg-emerald-500"
        : confidence >= 60
          ? "bg-yellow-400"
          : "bg-red-400"
      : "";
  const confColor =
    confidence !== undefined
      ? confidence >= 80
        ? "text-emerald-600"
        : confidence >= 60
          ? "text-yellow-600"
          : "text-red-500"
      : "";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        {confidence !== undefined && (
          <span className={cn("text-xs font-medium", confColor)}>{confidence}%</span>
        )}
      </div>
      <p className="text-sm font-semibold text-text-main">{value}</p>
      {confidence !== undefined && (
        <div className="w-full bg-gray-100 h-1.5 mt-1.5 rounded-full overflow-hidden">
          <div className={cn("h-1.5 rounded-full transition-all", barColor)} style={{ width: `${confidence}%` }} />
        </div>
      )}
      {source && (
        <p className="text-[10px] text-text-muted mt-1 italic truncate" title={source}>
          &ldquo;{source}&rdquo;
        </p>
      )}
    </div>
  );
}

interface ResultDisplayProps {
  result: IngestResponse;
  onReset: () => void;
}

export function ResultDisplay({ result, onReset }: ResultDisplayProps) {
  const detectedCurrency = result.extraction?.currency || "USD";

  return (
    <div className="rounded-lg border border-secondary/30 bg-surface-card p-6 shadow-card">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary">
            {result.isUpdate ? "update" : result.summary ? "checklist" : "check_circle"}
          </span>
          <h2 className="text-lg font-bold text-text-main">
              {result.summary
                ? "Bulk Import Complete"
                : result.isUpdate
                  ? "Deal Updated"
                  : "Deal Created"}
          </h2>
        </div>
        {result.extraction?.needsReview && (
          <div className="px-2.5 py-1 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">warning</span>
            Needs Review
          </div>
        )}
      </div>

      {/* Extraction fields */}
      {result.extraction && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
          <div className="col-span-full">
            <ResultField
              label="Company Name"
              value={result.extraction.companyName?.value as string || "\u2014"}
              confidence={result.extraction.companyName?.confidence}
              source={result.extraction.companyName?.source}
            />
          </div>
          <ResultField
            label="Industry"
            value={result.extraction.industry?.value as string || (result.extraction.industry?.confidence === 0 ? "Not Found" : "\u2014")}
            confidence={result.extraction.industry?.confidence}
            source={result.extraction.industry?.source}
          />
          <ResultField
            label="Overall Confidence"
            value={`${result.extraction.overallConfidence || 0}%`}
            confidence={result.extraction.overallConfidence}
          />
          <ResultField
            label="Revenue"
            value={result.extraction.revenue?.value != null
              ? formatCurrency(result.extraction.revenue.value as number, detectedCurrency)
              : (result.extraction.revenue?.confidence === 0 ? "Not Found" : "\u2014")}
            confidence={result.extraction.revenue?.confidence}
            source={result.extraction.revenue?.source}
          />
          <ResultField
            label="EBITDA"
            value={result.extraction.ebitda?.value != null
              ? formatCurrency(result.extraction.ebitda.value as number, detectedCurrency)
              : (result.extraction.ebitda?.confidence === 0 ? "Not Found" : "\u2014")}
            confidence={result.extraction.ebitda?.confidence}
            source={result.extraction.ebitda?.source}
          />
        </div>
      )}

      {/* Bulk summary */}
      {result.summary && (
        <div className="grid grid-cols-3 gap-4 mb-5">
          <div className="bg-background-body rounded-lg p-3 text-center">
            <p className="text-lg font-bold text-emerald-600">{result.summary.imported}</p>
            <p className="text-xs text-text-muted">Imported</p>
          </div>
          <div className="bg-background-body rounded-lg p-3 text-center">
            <p className="text-lg font-bold text-red-500">{result.summary.failed}</p>
            <p className="text-xs text-text-muted">Failed</p>
          </div>
          <div className="bg-background-body rounded-lg p-3 text-center">
            <p className="text-lg font-bold text-text-main">{result.summary.total}</p>
            <p className="text-xs text-text-muted">Total</p>
          </div>
        </div>
      )}

      {/* Review reasons — strip the trailing "(N% confidence)" parenthetical
          from each reason. The substring is the per-field score from the
          fast-pass extractor (aiExtractor.ts), but reads like the OVERALL
          extraction is at 0% when surfaced verbatim. The overall % is
          already shown in its own ResultField above. */}
      {result.extraction?.needsReview && result.extraction.reviewReasons && result.extraction.reviewReasons.length > 0 && (
        <div className="mt-4 p-3 rounded-lg bg-yellow-50 border border-yellow-200">
          <p className="text-xs font-medium text-yellow-800 mb-1">Items needing review:</p>
          <ul className="text-xs text-yellow-700 list-disc list-inside space-y-0.5">
            {result.extraction.reviewReasons.map((r, i) => (
              <li key={i}>{r.replace(/\s*\(\d+%\s*confidence\)\s*$/i, "")}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 mt-5">
        {result.deal ? (
          <a
            href={`/deals/${result.deal.id}`}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">open_in_new</span>
            View Deal
          </a>
        ) : result.summary ? (
          <a
            href="/crm"
            className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">list</span>
            View All Deals
          </a>
        ) : null}
        <button
          onClick={onReset}
          className="py-2.5 px-4 rounded-lg text-sm font-medium text-text-secondary border border-border-subtle hover:bg-gray-50 transition-all flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          Add Another
        </button>
      </div>
    </div>
  );
}


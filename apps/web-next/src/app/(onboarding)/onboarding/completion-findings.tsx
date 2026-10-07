"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// Dynamic completion findings — fetches real red-flag / analysis data when
// onboarding is fully complete. Ported from onboarding-flow.js
// loadCompletionFindings + renderFindings + renderNoFindings +
// SEVERITY_CONFIG + startDeepResearchPolling + showDeepResearchNotification.

interface RedFlag {
  title?: string;
  flag?: string;
  description?: string;
  detail?: string;
  explanation?: string;
  source?: string;
  severity?: string;
  type?: string;
  // POST /deals/:id/analyze-risks (apps/api/src/routes/ai.ts:263) returns
  // risks shaped { title, description, severity, mitigation }. We map
  // `mitigation` into the legacy `detail`/`explanation` slot at the call
  // site so renderFindings stays unchanged.
  mitigation?: string;
}

const SEVERITY_CONFIG: Record<
  string,
  { icon: string; iconColor: string; badge: string; badgeClass: string }
> = {
  critical: { icon: "warning", iconColor: "text-red-500", badge: "Critical", badgeClass: "text-red-600 bg-red-50" },
  high: { icon: "warning", iconColor: "text-red-500", badge: "High", badgeClass: "text-red-600 bg-red-50" },
  warning: { icon: "error", iconColor: "text-amber-500", badge: "Watch", badgeClass: "text-amber-700 bg-amber-50" },
  medium: { icon: "error", iconColor: "text-amber-500", badge: "Watch", badgeClass: "text-amber-700 bg-amber-50" },
  positive: { icon: "trending_up", iconColor: "text-secondary", badge: "Positive", badgeClass: "text-secondary bg-secondary-light" },
  low: { icon: "info", iconColor: "text-blue-500", badge: "Info", badgeClass: "text-blue-600 bg-blue-50" },
};

export function CompletionFindings({
  onDealId,
}: {
  onDealId?: (id: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("Checking what your AI analyst found...");
  const [subtitle, setSubtitle] = useState("Loading findings from your deal.");
  const [findings, setFindings] = useState<RedFlag[]>([]);
  const [noFindings, setNoFindings] = useState(false);
  const [statementCount, setStatementCount] = useState(0);
  const [dealId, setDealId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // POST /deals/:id/analyze-risks (apps/api/src/routes/ai.ts) returns
  // { risks: Array<{ title, description, severity, mitigation }>, dealId, cached }.
  // The backend caches the result via AICache, so a repeat click is cheap.
  const runRiskScan = useCallback(async () => {
    if (!dealId || scanning) return;
    setScanning(true);
    setScanError(null);
    try {
      const analysis = await api.post<{
        risks?: RedFlag[] | { flags?: RedFlag[] };
        redFlags?: { flags?: RedFlag[] } | RedFlag[];
      }>(`/deals/${dealId}/analyze-risks`, {});
      // Backend returns `risks`, but accept `redFlags` shapes too in case
      // the response shape changes — the renderer handles both keys via
      // the same RedFlag interface above.
      const risksValue = analysis?.risks ?? analysis?.redFlags;
      const flags = Array.isArray(risksValue)
        ? risksValue
        : (risksValue as { flags?: RedFlag[] } | undefined)?.flags ?? [];
      if (flags.length > 0) {
        const top5 = flags.slice(0, 5);
        setTitle(
          `Your AI analyst found ${top5.length} thing${top5.length > 1 ? "s" : ""} on your deal.`,
        );
        setSubtitle("Here's a preview. Click any finding to see the exact page it came from.");
        setFindings(top5);
      } else {
        setScanError("No red flags found on this deal.");
      }
    } catch (err) {
      console.warn("[onboarding/completion] risk scan failed:", err);
      setScanError(err instanceof Error ? err.message : "The AI risk scan could not run.");
    } finally {
      setScanning(false);
    }
  }, [dealId, scanning]);

  // Deep research polling
  const [deepNotification, setDeepNotification] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollCountRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollCountRef.current++;
      if (pollCountRef.current > 36) {
        stopPolling();
        return;
      }
      try {
        const data = await api.get<{ phase?: number; status?: string; newInsightsCount?: number }>(
          "/onboarding/research-status",
        );
        if (data.phase === 2 && data.status === "complete") {
          stopPolling();
          if (data.newInsightsCount && data.newInsightsCount > 0) {
            setDeepNotification(data.newInsightsCount);
          }
        }
      } catch (err) {
        // Silent polling — keep retrying.
        console.warn("[onboarding/completion] research-status poll failed:", err);
      }
    }, 5000);
  }, [stopPolling]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Fetch the user's most recent deal
        const dealsData = await api.get<
          { id: string }[] | { deals?: { id: string }[] }
        >("/deals?sortBy=updatedAt&sortOrder=desc");
        if (cancelled) return;

        const deals = Array.isArray(dealsData) ? dealsData : (dealsData?.deals ?? []);
        if (deals.length === 0) {
          renderNoFindings();
          return;
        }

        const dealId = deals[0].id;
        onDealId?.(dealId);

        setDealId(dealId);
        // The AI risk scan (POST /deals/:id/analyze-risks) runs only when the
        // user clicks "Find red flags with AI" — opening this screen never
        // spends AI credit.

        // Check financial statements
        try {
          const finData = await api.get<
            { id: string }[] | { statements?: { id: string }[] }
          >(`/deals/${dealId}/financials`);
          if (cancelled) return;

          const statements = Array.isArray(finData) ? finData : (finData?.statements ?? []);
          if (statements.length > 0) {
            setTitle("Your workspace is ready.");
            setSubtitle(
              `We extracted ${statements.length} financial statement${statements.length > 1 ? "s" : ""} from your deal. Dive in to see the full analysis.`,
            );
            setStatementCount(statements.length);
            setLoading(false);
            return;
          }
        } catch (err) {
          // fall through to no-findings state.
          console.warn("[onboarding/completion] failed to load financials:", err);
        }

        renderNoFindings();
        startPolling();
      } catch (err) {
        console.warn("[onboarding/completion] failed to fetch deals:", err);
        renderNoFindings();
      }
    })();

    function renderNoFindings() {
      if (cancelled) return;
      setTitle("Your workspace is ready.");
      setSubtitle("Your AI analyst is still processing. Findings will appear on your dashboard shortly.");
      setNoFindings(true);
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* Deep research notification */}
      {deepNotification !== null && (
        <div className="mb-3 flex items-center justify-between gap-3 p-3 rounded-lg border border-primary/20 bg-primary-light/40 animate-[slideDown_300ms_ease-out_both]">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: "#003366" }}
            >
              <span
                className="material-symbols-outlined text-white text-[16px]"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                auto_awesome
              </span>
            </div>
            <div>
              <div className="text-[13px] font-semibold text-text-main flex items-center gap-2">
                Your AI analyst found {deepNotification} more insight
                {deepNotification > 1 ? "s" : ""} about your firm
                <PulseDot />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDeepNotification(null)}
            className="text-text-muted hover:text-text-main p-1"
          >
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      <h3 className="font-display text-[24px] font-bold text-text-main">{title}</h3>
      <p className="text-[13.5px] text-text-secondary mt-1.5 mb-5">{subtitle}</p>

      {/* Loading shimmer */}
      {loading && (
        <div className="space-y-2.5">
          <div className="h-16 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-16 rounded-lg bg-gray-100 animate-pulse" />
          <div className="h-16 rounded-lg bg-gray-100 animate-pulse" />
        </div>
      )}

      {/* Red flag findings */}
      {!loading && findings.length > 0 && (
        <div className="space-y-2.5">
          {findings.map((flag, i) => {
            const severity = (flag.severity || flag.type || "medium").toLowerCase();
            const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.medium;
            const flagTitle = flag.title || flag.flag || "Finding";
            // analyze-risks returns { title, description, mitigation } —
            // legacy red-flag analyses use { detail, explanation, source }.
            // Prefer the long-form fields in the order most useful for the
            // single-line row beneath the title.
            const detail =
              flag.detail ||
              flag.explanation ||
              flag.description ||
              flag.mitigation ||
              flag.source ||
              "";
            return (
              <div
                key={i}
                className="border border-border-subtle rounded-lg p-3.5 flex items-start gap-3 hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <span
                  className={`material-symbols-outlined ${config.iconColor} mt-0.5 text-[20px]`}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {config.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold">{flagTitle}</div>
                  {detail && <div className="text-[12px] text-text-muted mt-0.5">{detail}</div>}
                </div>
                <span
                  className={`text-[11px] font-semibold uppercase px-2 py-0.5 rounded flex-shrink-0 ${config.badgeClass}`}
                >
                  {config.badge}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* AI risk scan — on click only */}
      {!loading && dealId && findings.length === 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={runRiskScan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
          >
            <span className={`material-symbols-outlined text-[16px] ${scanning ? "animate-spin" : ""}`}>
              {scanning ? "progress_activity" : "auto_awesome"}
            </span>
            {scanning ? "Scanning…" : "Find red flags with AI"}
          </button>
          {scanError && <span className="text-[12px] text-text-muted" role="status">{scanError}</span>}
        </div>
      )}

      {/* No findings — AI still processing */}
      {!loading && noFindings && statementCount === 0 && findings.length === 0 && (
        <div className="border border-border-subtle rounded-lg p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary-light flex items-center justify-center flex-shrink-0">
            <span
              className="material-symbols-outlined text-primary text-[20px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              auto_awesome
            </span>
          </div>
          <div>
            <div className="text-[13.5px] font-semibold text-text-main">AI extraction in progress</div>
            <div className="text-[12px] text-text-muted mt-0.5">
              Red flags, financials, and signals will stream in as they&apos;re discovered.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PulseDot() {
  return <span className="pulse-dot inline-block flex-shrink-0" />;
}

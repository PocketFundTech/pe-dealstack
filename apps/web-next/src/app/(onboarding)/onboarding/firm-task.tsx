"use client";

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { api, ApiError } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import { TaskModalShell } from "./task-modal-shell";
import { AUM_OPTIONS, DEFAULT_SECTORS, FirmData } from "./types";
import { EnrichmentResponse, matchAumBucket, matchSectors } from "./enrichment-types";
import { ProfileReportModal } from "./profile-report-modal";
import { TeaserSeedCard } from "./teaser-seed-card";

// Firm task modal — form for website/linkedin + fund size + sectors.
// Ported from OnboardingTasks._renderers.firm + _hydrators.firm in
// onboarding-tasks.js. AI enrichment button is
// deferred — user fills the form manually for now.
export function FirmTaskModal({
  value,
  onChange,
  onClose,
  onComplete,
  busy = false,
}: {
  value: FirmData;
  onChange: (v: FirmData) => void;
  onClose: () => void;
  onComplete: () => void;
  busy?: boolean;
}) {
  const { showToast } = useToast();
  const [customSectorOpen, setCustomSectorOpen] = useState(false);
  const [customSector, setCustomSector] = useState("");

  // Enrichment state — ported from triggerEnrichment/applyEnrichmentToForm.
  // Fires on URL or LinkedIn blur, shows preview card with "View report"
  // + "Use this profile".
  const [enrichState, setEnrichState] = useState<"idle" | "loading" | "done" | "applied" | "error">("idle");
  const [enrichResult, setEnrichResult] = useState<EnrichmentResponse | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);

  const canComplete = value.aum !== "" && value.sectors.length > 0;

  const toggleSector = (sector: string) => {
    const next = value.sectors.includes(sector)
      ? value.sectors.filter((s) => s !== sector)
      : [...value.sectors, sector];
    onChange({ ...value, sectors: next });
  };

  const addCustomSector = () => {
    const trimmed = customSector.trim();
    if (!trimmed || value.sectors.includes(trimmed)) return;
    onChange({ ...value, sectors: [...value.sectors, trimmed] });
    setCustomSector("");
  };

  const handleCustomKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomSector();
    }
  };

  const extraSectors = value.sectors.filter((s) => !DEFAULT_SECTORS.includes(s));

  const triggerEnrichment = async () => {
    const url = value.url.trim();
    const linkedin = value.linkedin.trim();
    if (!url && !linkedin) return;
    // Only block if a request is already in flight. Previously also
    // short-circuited on "applied", which silently swallowed a LinkedIn
    // blur after the user had applied a website-only enrichment.
    if (enrichState === "loading") return;

    setEnrichState("loading");
    setEnrichError(null);
    try {
      const res = await api.post<EnrichmentResponse>("/onboarding/enrich-firm", {
        websiteUrl: url || undefined,
        linkedinUrl: linkedin || undefined,
      });
      if (res.success && res.firmProfile) {
        setEnrichResult(res);
        setEnrichState("done");
      } else {
        const msg = res.error || "Could not auto-fill from website. Fill in manually.";
        setEnrichError(msg);
        setEnrichState("error");
      }
    } catch (err) {
      // 429 = backend's 3-per-hour AI enrichment cap. Surface clearly so user
      // knows to fill in manually.
      if (err instanceof ApiError && err.status === 429) {
        const msg = "AI enrichment rate limit reached — fill out the form manually below.";
        setEnrichError(msg);
        setEnrichState("error");
        showToast(msg, "warning");
      } else {
        const msg = err instanceof Error ? err.message : "Enrichment failed — fill in manually below.";
        setEnrichError(msg);
        setEnrichState("error");
      }
    }
  };

  const applyEnrichedProfile = () => {
    if (!enrichResult?.firmProfile) return;
    const firm = enrichResult.firmProfile;
    const nextAum = matchAumBucket(firm) ?? value.aum;
    const matched = matchSectors(firm);
    const merged = [...value.sectors];
    for (const s of matched) {
      if (!merged.includes(s)) merged.push(s);
    }
    onChange({ ...value, aum: nextAum, sectors: merged });
    setEnrichState("applied");
  };

  return (
    <TaskModalShell
      icon="business"
      title="Define your investment focus"
      onClose={onClose}
      onComplete={onComplete}
      canComplete={canComplete}
      busy={busy}
      busyLabel="Saving..."
    >
      <p className="text-[13.5px] text-text-secondary mb-4">
        Help us tailor AI findings to your strategy. This takes 30 seconds.
      </p>

      <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Firm website</label>
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
          link
        </span>
        <input
          type="url"
          value={value.url}
          onChange={(e) => onChange({ ...value, url: e.target.value })}
          onBlur={() => {
            if (value.url.trim().length > 3) triggerEnrichment();
          }}
          placeholder="yourfirm.com"
          className="w-full pl-10 pr-3 py-2.5 text-[14px] rounded-lg border border-border-subtle focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
        />
      </div>

      <label className="block text-[12px] font-medium text-text-secondary mb-1.5">LinkedIn</label>
      <div className="relative mb-4">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
          person
        </span>
        <input
          type="url"
          value={value.linkedin}
          onChange={(e) => onChange({ ...value, linkedin: e.target.value })}
          onBlur={() => {
            // Lowercase check so pasted "LinkedIn.com" / "Linkedin.com"
            // still fire the enrichment.
            if (value.linkedin.toLowerCase().includes("linkedin.com")) triggerEnrichment();
          }}
          placeholder="https://linkedin.com/in/yourprofile"
          className="w-full pl-10 pr-3 py-2.5 text-[14px] rounded-lg border border-border-subtle focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
        />
      </div>

      {enrichState !== "idle" && (
        <EnrichmentPanel
          state={enrichState}
          result={enrichResult}
          error={enrichError}
          onViewReport={() => setShowReport(true)}
          onUseProfile={applyEnrichedProfile}
        />
      )}

      <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Fund size</label>
      <div className="grid grid-cols-4 gap-2 mb-4">
        {AUM_OPTIONS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange({ ...value, aum: v })}
            className={cn(
              "p-2.5 text-[12.5px] rounded-lg border transition-all",
              value.aum === v
                ? "border-primary bg-[#F5F9FD] text-primary shadow-[inset_0_0_0_1px_#003366]"
                : "border-border-subtle bg-white text-text-secondary hover:border-border-focus hover:bg-[#FAFBFC]",
            )}
          >
            {v}
          </button>
        ))}
      </div>

      <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Sectors you focus on</label>
      <div className="flex flex-wrap gap-2">
        {DEFAULT_SECTORS.map((s) => {
          const selected = value.sectors.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleSector(s)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                selected ? "bg-primary-light border-primary text-primary" : "bg-white border-border-subtle text-text-secondary hover:border-border-focus",
              )}
            >
              {s}
            </button>
          );
        })}
        {extraSectors.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleSector(s)}
            className="rounded-full bg-primary-light border border-primary px-3 py-1.5 text-[12.5px] font-medium text-primary"
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomSectorOpen((v) => !v)}
          className="rounded-full bg-white border border-dashed border-border-subtle px-3 py-1.5 text-[12.5px] font-medium text-text-secondary hover:border-border-focus"
        >
          + Other
        </button>
      </div>

      {customSectorOpen && (
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            value={customSector}
            onChange={(e) => setCustomSector(e.target.value)}
            onKeyDown={handleCustomKey}
            placeholder="e.g. Real Estate, Biotech..."
            className="flex-1 px-3 py-2 text-[13px] rounded-lg border border-border-subtle focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
          />
          <button
            type="button"
            onClick={addCustomSector}
            className="text-[12px] font-semibold text-white px-3 py-2 rounded-lg hover:opacity-90"
            style={{ backgroundColor: "#003366" }}
          >
            Add
          </button>
        </div>
      )}

      {/* Optional, skippable: seed the firm's first Firm Teaser profile.
          Independent of "Mark as done" — never blocks onboarding completion. */}
      <TeaserSeedCard />

      {showReport && enrichResult && (
        <ProfileReportModal result={enrichResult} onClose={() => setShowReport(false)} />
      )}
    </TaskModalShell>
  );
}

function EnrichmentPanel({
  state,
  result,
  error,
  onViewReport,
  onUseProfile,
}: {
  state: "loading" | "done" | "applied" | "error";
  result: EnrichmentResponse | null;
  error: string | null;
  onViewReport: () => void;
  onUseProfile: () => void;
}) {
  // Phase 2 deep-research polling — ported from onboarding-tasks.js
  // triggerEnrichment Phase 2 status section. Polls /onboarding/research-status
  // every 5s for up to 90s.
  const [phase2, setPhase2] = useState<"polling" | "complete" | "timeout">("polling");
  const [phase2Count, setPhase2Count] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const stopPhase2 = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Start polling when entering "done" state (enrichment succeeded)
  useEffect(() => {
    if (state !== "done") return;
    if (pollRef.current) return;
    pollCountRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollCountRef.current++;
      // Safety timeout after 90s (18 polls at 5s)
      if (pollCountRef.current > 18) {
        stopPhase2();
        setPhase2("timeout");
        return;
      }
      try {
        const data = await api.get<{ phase?: number; status?: string; newInsightsCount?: number }>(
          "/onboarding/research-status",
        );
        if (data.phase === 2 && data.status === "complete") {
          stopPhase2();
          setPhase2("complete");
          if (data.newInsightsCount) setPhase2Count(data.newInsightsCount);
        }
      } catch (err) {
        // Silent polling — keep retrying.
        console.warn("[onboarding/firm-task] research-status poll failed:", err);
      }
    }, 5000);
    return () => stopPhase2();
  }, [state, stopPhase2]);

  if (state === "loading") {
    return (
      <div className="mb-4 p-3 rounded-lg bg-primary-light/40 flex items-center gap-2 text-[12px] text-primary font-medium">
        <div className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        Researching your firm — scanning website, searching news &amp; deals...
      </div>
    );
  }
  if (state === "applied") {
    return (
      <div className="mb-4 p-3 rounded-lg bg-secondary-light/40 flex items-center gap-2 text-[12px] text-secondary font-medium">
        <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>
          check_circle
        </span>
        Profile saved — AI will use this context across your deals.
      </div>
    );
  }
  if (state === "error") {
    return <div className="mb-4 p-2.5 rounded-lg bg-gray-50 text-[12px] text-text-muted">{error}</div>;
  }
  // "done" — preview card
  const firm = result?.firmProfile;
  const person = result?.personProfile;
  if (!firm) return null;
  const trimmedDesc = firm.description
    ? firm.description.slice(0, 120) + (firm.description.length > 120 ? "..." : "")
    : "";
  return (
    <div className="mb-4 rounded-lg border border-secondary/30 bg-secondary-light/20 p-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-[12px] text-secondary font-semibold">
          <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>
            check_circle
          </span>
          Profile researched
          {firm.confidence === "low" && <span className="text-amber-600">(low confidence)</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onViewReport}
            className="text-[11px] font-medium text-primary px-2 py-1 rounded-md border border-primary/30 hover:bg-primary-light bg-white transition-colors"
          >
            View full report
          </button>
          <button
            type="button"
            onClick={onUseProfile}
            className="text-[11px] font-semibold text-white px-3 py-1 rounded-md hover:opacity-90 transition-opacity"
            style={{ backgroundColor: "#003366" }}
          >
            Use this profile
          </button>
        </div>
      </div>
      <div className="text-[12px] text-text-main space-y-1">
        {trimmedDesc && (
          <div>
            <span className="text-text-muted">Firm:</span> {trimmedDesc}
          </div>
        )}
        {firm.headquarters && (
          <div>
            <span className="text-text-muted">HQ:</span> {firm.headquarters}
          </div>
        )}
        {person?.title && (
          <div>
            <span className="text-text-muted">You:</span> {person.title}
            {person.bio && <> — {person.bio.slice(0, 80)}</>}
          </div>
        )}
      </div>
      {/* Phase 2 deep research status */}
      <div className="mt-2 pt-2 border-t border-secondary/20">
        {phase2 === "polling" && (
          <div className="flex items-center gap-2 text-[11px] text-primary font-medium">
            <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            Researching deeper — following leads, checking press, social...
          </div>
        )}
        {phase2 === "complete" && (
          <div className="flex items-center gap-2 text-[11px] text-secondary font-semibold">
            <span
              className="material-symbols-outlined text-[14px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              auto_awesome
            </span>
            Deep research complete
            {phase2Count > 0 && <> — {phase2Count} additional insight{phase2Count > 1 ? "s" : ""} found and saved</>}
          </div>
        )}
        {phase2 === "timeout" && (
          <div className="flex items-center gap-2 text-[11px] text-secondary font-medium">
            <span
              className="material-symbols-outlined text-[14px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              check_circle
            </span>
            Deep research saved — more insights will appear in your dashboard.
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "@/lib/api";
import { authFetchRaw } from "../deal-intake/components";

// ─── Types ──────────────────────────────────────────────────────────

interface FirmProfileData {
  firmName?: string;
  description?: string;
  headquarters?: string;
  founded?: string;
  aum?: string;
  investmentFocus?: string[] | string;
  sectorFocus?: string[] | string;
  dealSize?: string;
  notableDeals?: string[] | string;
  teamSize?: string;
  website?: string;
}

interface UserMeResponse {
  organization?: {
    website?: string;
    settings?: {
      firmProfile?: FirmProfileData;
      firmWebsite?: string;
      firmLinkedin?: string;
      firmDocText?: string;
    };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function toDisplayValue(value: string[] | string | undefined): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

const FIELDS: { label: string; key: keyof FirmProfileData }[] = [
  { label: "Firm Name", key: "firmName" },
  { label: "Description", key: "description" },
  { label: "Headquarters", key: "headquarters" },
  { label: "Founded", key: "founded" },
  { label: "AUM", key: "aum" },
  { label: "Investment Focus", key: "investmentFocus" },
  { label: "Sector Focus", key: "sectorFocus" },
  { label: "Deal Size", key: "dealSize" },
  { label: "Notable Deals", key: "notableDeals" },
  { label: "Team Size", key: "teamSize" },
  { label: "Website", key: "website" },
];

// ─── Component ──────────────────────────────────────────────────────

export function FirmProfileSection() {
  const [firmProfile, setFirmProfile] = useState<FirmProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<{
    type: "success" | "error" | "loading";
    text: string;
  } | null>(null);

  // org data for refresh call
  const [orgWebsite, setOrgWebsite] = useState("");
  const [orgLinkedin, setOrgLinkedin] = useState("");

  // firm-provided document/notes — an authoritative source the AI research uses
  const [firmDocText, setFirmDocText] = useState("");
  const [docFilename, setDocFilename] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFilePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setExtracting(true);
    setDocError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetchRaw("/firm-teaser/extract-context", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Couldn't read that file (${res.status})`);
      const data = (await res.json()) as { text?: string; filename?: string };
      const text = (data.text || "").trim();
      if (!text) throw new Error("No readable text found in that file.");
      setFirmDocText((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text));
      setDocFilename(data.filename || file.name);
    } catch (err) {
      console.warn("[settings/firm-profile] doc extract failed:", err);
      setDocError(err instanceof Error ? err.message : "Couldn't read that file.");
    } finally {
      setExtracting(false);
    }
  };

  const loadFirmProfile = useCallback(async () => {
    try {
      const data = await api.get<UserMeResponse>("/users/me");
      const orgSettings = data?.organization?.settings || {};
      setFirmProfile(orgSettings.firmProfile || null);
      setOrgWebsite(orgSettings.firmWebsite || data?.organization?.website || "");
      setOrgLinkedin(orgSettings.firmLinkedin || "");
      setFirmDocText(orgSettings.firmDocText || "");
      setLoadError(false);
    } catch (err) {
      console.warn("[settings/firm-profile] failed to load:", err);
      setFirmProfile(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFirmProfile();
  }, [loadFirmProfile]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshStatus({
      type: "loading",
      text: "Researching your firm (15-25 seconds)...",
    });

    try {
      const result = await api.post<{ success: boolean; error?: string }>(
        "/onboarding/enrich-firm",
        {
          websiteUrl: orgWebsite,
          linkedinUrl: orgLinkedin,
          documentText: firmDocText,
        },
      );

      if (result.success) {
        setRefreshStatus({
          type: "success",
          text: "Profile refreshed successfully",
        });
        // Reload the firm profile data after a short delay
        setTimeout(() => {
          loadFirmProfile();
          setRefreshStatus(null);
        }, 1500);
      } else {
        setRefreshStatus({
          type: "error",
          text: result.error || "Refresh failed. Try again.",
        });
      }
    } catch (err) {
      console.warn("[settings/firm-profile] enrich-firm failed:", err);
      setRefreshStatus({
        type: "error",
        text: "Refresh failed. Try again.",
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setRefreshStatus({ type: "loading", text: "Saving…" });
    try {
      await api.post("/onboarding/firm-inputs", {
        websiteUrl: orgWebsite,
        linkedinUrl: orgLinkedin,
        documentText: firmDocText,
      });
      setRefreshStatus({ type: "success", text: "Saved" });
      setTimeout(() => setRefreshStatus(null), 1500);
    } catch (err) {
      console.warn("[settings/firm-profile] save failed:", err);
      setRefreshStatus({ type: "error", text: "Save failed. Try again." });
    } finally {
      setSaving(false);
    }
  };

  const displayFields = firmProfile
    ? FIELDS.map((f) => ({
        label: f.label,
        value: toDisplayValue(
          firmProfile[f.key] as string | string[] | undefined,
        ),
      })).filter((f) => f.value)
    : [];

  return (
    <section
      id="section-firm-profile"
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
    >
      <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-light rounded-lg text-primary border border-primary/20">
            <span className="material-symbols-outlined text-[20px] block">domain</span>
          </div>
          <div>
            <h2 className="text-base font-bold text-text-main">Firm Profile</h2>
            <p className="text-xs text-text-muted">
              AI-researched profile of your firm. Used as context across deal analysis.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {refreshStatus && (
            <div
              className={`text-sm flex items-center gap-2 ${
                refreshStatus.type === "success"
                  ? "text-green-600"
                  : refreshStatus.type === "error"
                    ? "text-red-500"
                    : "text-primary"
              }`}
            >
              {refreshStatus.type === "loading" && (
                <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              )}
              {refreshStatus.type === "success" && (
                <span
                  className="material-symbols-outlined text-[16px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
              )}
              {refreshStatus.text}
            </div>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || refreshing || extracting}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-border-subtle hover:bg-gray-50 transition-colors shadow-sm text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={`material-symbols-outlined text-[16px] ${saving ? "animate-spin" : ""}`}>
              {saving ? "progress_activity" : "save"}
            </span>
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || extracting || (!orgWebsite.trim() && !orgLinkedin.trim() && !firmDocText.trim())}
            title={!orgWebsite.trim() && !orgLinkedin.trim() && !firmDocText.trim() ? "Add a website, LinkedIn URL, or firm document/notes below first" : undefined}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: "#003366" }}
          >
            <span className={`material-symbols-outlined text-[16px] ${refreshing ? "animate-spin" : ""}`}>
              {refreshing ? "progress_activity" : firmProfile ? "refresh" : "travel_explore"}
            </span>
            {refreshing ? "Researching…" : firmProfile ? "Refresh profile" : "Research firm"}
          </button>
        </div>
      </div>
      <div className="p-6">
        {/* Source inputs — the research agent needs at least one of these. They
            persist to org settings on a successful refresh (see firmResearchAgent
            save node), so they survive reloads. */}
        <div className="mb-5 grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">Firm website</span>
            <input
              type="url"
              value={orgWebsite}
              onChange={(e) => setOrgWebsite(e.target.value)}
              placeholder="https://yourfirm.com"
              className="mt-1 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">LinkedIn URL</span>
            <input
              type="url"
              value={orgLinkedin}
              onChange={(e) => setOrgLinkedin(e.target.value)}
              placeholder="https://linkedin.com/company/yourfirm"
              className="mt-1 w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <p className="md:col-span-2 text-xs text-text-muted">
            Provide at least one source below — a URL, an uploaded document, or pasted notes — then click <span className="font-medium">Research firm</span> in the top-right. The AI researches your firm and saves the result below.
          </p>
        </div>

        {/* Firm-provided document / notes — authoritative source for the AI research */}
        <div className="mb-5">
          <span className="text-xs font-bold text-text-secondary uppercase tracking-wider">Firm document or notes (optional)</span>
          <p className="text-xs text-text-muted mb-2">
            Upload a deck / one-pager (PDF, Word, Excel, text) or paste notes about your firm — the AI treats this as an authoritative source, even with no website.
          </p>
          <div className="flex items-center gap-3 mb-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv"
              onChange={handleFilePick}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={extracting}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-border-subtle hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <span className={`material-symbols-outlined text-[16px] ${extracting ? "animate-spin" : ""}`}>
                {extracting ? "progress_activity" : "upload_file"}
              </span>
              {extracting ? "Extracting…" : "Upload document"}
            </button>
            {docFilename && !extracting && (
              <span className="text-xs text-text-muted truncate">Added: {docFilename}</span>
            )}
          </div>
          {docError && <p className="text-xs text-red-500 mb-2">{docError}</p>}
          <textarea
            value={firmDocText}
            onChange={(e) => setFirmDocText(e.target.value)}
            placeholder="Paste firm background, strategy, sectors, AUM, notable deals…"
            rows={4}
            className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        {loading ? (
          <p className="text-sm text-text-muted">Loading firm profile...</p>
        ) : loadError ? (
          <p className="text-sm text-text-muted">Could not load firm profile.</p>
        ) : !firmProfile || displayFields.length === 0 ? (
          <p className="text-sm text-text-muted">
            {firmProfile
              ? 'No firm profile data available. Click "Refresh profile" to generate one.'
              : 'No firm profile yet. Click "Refresh profile" to generate one using AI research.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {displayFields.map((field) => (
              <div key={field.label}>
                <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-1">
                  {field.label}
                </p>
                <p className="text-sm text-text-main">{field.value}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

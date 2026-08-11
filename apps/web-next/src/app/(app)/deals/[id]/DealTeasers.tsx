"use client";

import { useCallback, useEffect, useState } from "react";
import { api, NotFoundError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import { useToast } from "@/providers/ToastProvider";
import type { DealTeaser } from "@/lib/teaser";
import { TeaserFitChip } from "./deal-teaser-fit-chip";

// ---------------------------------------------------------------------------
// Firm Teaser tab — internal triage blurbs Claude writes per firm profile.
//
// On mount, GET /deals/:id/teasers (one teaser per already-generated profile).
// Each teaser is grouped by profileName: the headline up top, then a
// criterion-by-criterion fit breakdown, a "Criteria changed" badge when stale,
// and a per-profile Regenerate button (POST /deals/:id/teasers { profileId }).
//
// The API + DB migration may not be deployed yet, so the GET can 404/500.
// NotFoundError is treated as "feature not live" -> friendly empty state; any
// other error surfaces inline but never crashes the deal page.
// ---------------------------------------------------------------------------

const SETTINGS_HINT =
  "Set up named investment-criteria profiles in Settings to generate teasers.";

interface DealTeasersResponse {
  teasers: DealTeaser[];
}

interface RegenerateResponse {
  teaser: DealTeaser;
}

export function DealTeasers({ dealId }: { dealId: string }) {
  const { showToast } = useToast();
  const [teasers, setTeasers] = useState<DealTeaser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // profileId currently regenerating (disables just that card's button).
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const loadTeasers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<DealTeasersResponse>(`/deals/${dealId}/teasers`);
      setTeasers(data.teasers ?? []);
    } catch (err) {
      // 404 = endpoint/migration not deployed yet. Treat as an empty state
      // (no profiles, no teasers) rather than an error so the tab still works.
      if (err instanceof NotFoundError) {
        setTeasers([]);
      } else {
        const msg = err instanceof Error ? err.message : "Failed to load teasers";
        console.warn("[deal] loadTeasers failed:", err);
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    loadTeasers();
  }, [loadTeasers]);

  const handleRegenerate = useCallback(
    async (profileId: string, profileName?: string) => {
      setRegeneratingId(profileId);
      try {
        const { teaser } = await api.post<RegenerateResponse>(
          `/deals/${dealId}/teasers`,
          { profileId },
        );
        // Replace the matching profile's teaser in place (or append if it's
        // somehow new), so the list keeps its order and the stale flag clears.
        setTeasers((prev) => {
          const idx = prev.findIndex((t) => t.profileId === profileId);
          if (idx === -1) return [...prev, teaser];
          const next = [...prev];
          next[idx] = teaser;
          return next;
        });
        showToast(
          `Teaser regenerated for ${profileName || "this profile"}.`,
          "success",
          { title: "Teaser updated" },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to regenerate teaser";
        console.warn("[deal] regenerate teaser failed:", err);
        showToast(msg, "error", { title: "Regenerate failed" });
      } finally {
        setRegeneratingId(null);
      }
    },
    [dealId, showToast],
  );

  if (loading) {
    return <TeaserSkeleton />;
  }

  if (error) {
    return (
      <div className="py-8 text-center">
        <span className="material-symbols-outlined text-3xl text-text-muted">
          error_outline
        </span>
        <p className="mt-2 text-sm text-text-secondary">{error}</p>
        <button
          onClick={loadTeasers}
          className="mt-3 rounded-lg border border-border-subtle px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-primary/30 hover:text-primary"
        >
          Try again
        </button>
      </div>
    );
  }

  if (teasers.length === 0) {
    return <TeaserEmptyState />;
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      {teasers.map((teaser) => (
        <TeaserCard
          key={teaser.id || teaser.profileId}
          teaser={teaser}
          regenerating={regeneratingId === teaser.profileId}
          onRegenerate={() =>
            handleRegenerate(teaser.profileId, teaser.profileName)
          }
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One profile's teaser card
// ---------------------------------------------------------------------------

function TeaserCard({
  teaser,
  regenerating,
  onRegenerate,
}: {
  teaser: DealTeaser;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-white p-5 shadow-card">
      {/* Header: profile name + stale badge + regenerate */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-primary">
              center_focus_strong
            </span>
            <h3 className="truncate text-sm font-bold uppercase tracking-wider text-text-muted">
              {teaser.profileName || "Profile"}
            </h3>
          </div>
          {teaser.stale && (
            <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              <span className="material-symbols-outlined text-[14px]">history</span>
              Criteria changed — regenerate
            </span>
          )}
        </div>
        <button
          onClick={onRegenerate}
          disabled={regenerating}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors",
            regenerating
              ? "cursor-not-allowed opacity-60"
              : "hover:border-primary/30 hover:text-primary",
          )}
        >
          <span
            className={cn(
              "material-symbols-outlined text-[16px]",
              regenerating && "animate-spin",
            )}
          >
            {regenerating ? "progress_activity" : "autorenew"}
          </span>
          {regenerating ? "Regenerating…" : "Regenerate"}
        </button>
      </div>

      {/* Headline — the one-sentence blurb. Plain text, never dangerouslySet. */}
      <p className="mt-3 text-[15px] font-semibold leading-relaxed text-text-main">
        {teaser.headline}
      </p>

      {/* Fit breakdown */}
      {teaser.fits.length > 0 && (
        <div className="mt-3 divide-y divide-border-subtle border-t border-border-subtle">
          {teaser.fits.map((fit, i) => (
            <TeaserFitChip key={`${fit.criterion}-${i}`} fit={fit} />
          ))}
        </div>
      )}

      {/* Footer: model + generated time */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">smart_toy</span>
          {teaser.model}
        </span>
        <span aria-hidden>·</span>
        <span>Generated {formatRelativeTime(teaser.generatedAt)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading + empty states
// ---------------------------------------------------------------------------

function TeaserSkeleton() {
  return (
    <div className="flex flex-col gap-4 py-4">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-border-subtle bg-white p-5"
        >
          <div className="h-3 w-32 rounded bg-gray-100" />
          <div className="mt-3 h-4 w-full rounded bg-gray-100" />
          <div className="mt-2 h-4 w-3/4 rounded bg-gray-100" />
          <div className="mt-4 h-3 w-40 rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}

function TeaserEmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-subtle bg-white py-10 text-center">
      <span className="material-symbols-outlined text-4xl text-text-muted">
        center_focus_weak
      </span>
      <h3 className="mt-2 text-sm font-semibold text-text-main">No teasers yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">
        {SETTINGS_HINT}
      </p>
      <a
        href="/settings"
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[16px]">settings</span>
        Go to Settings → Firm Teaser
      </a>
    </div>
  );
}

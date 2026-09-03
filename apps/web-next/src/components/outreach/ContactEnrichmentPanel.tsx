"use client";

import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import {
  ENRICHMENT_PROVIDER_LABELS,
  ENRICHMENT_STATUS_CONFIG,
  type OutreachContact,
} from "./types";

// ---------------------------------------------------------------------------
// Contact detail side panel — rendered in ContactFormModal's edit mode only
// (a brand-new contact has no enrichment history yet). Two read-only
// sections: a computed "data completeness" bar over the fields enrichment
// actually fills in, and a per-provider enrichment log read off
// `contact.enrichmentData`.
//
// `enrichmentData` comes straight off the API typed as
// `Record<string, unknown> | null` (see types.ts) — every value pulled out
// of it here is validated/narrowed before it touches a lookup table. Never
// assume all three providers ran (skipped/unconfigured providers are simply
// absent, not present-with-status-skipped — see outreachEnrichment.ts), and
// never crash on an unexpected shape.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDateString(value: string | null): value is string {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

interface EnrichmentLogEntry {
  providerKey: string;
  status: string | null;
  fetchedAt: string | null;
}

/** Pull recognizable `{ status, fetchedAt }` entries out of the loosely-typed
 *  enrichmentData bag. An entry whose value isn't even an object is dropped
 *  entirely (nothing safe to render); a recognized entry with an
 *  unrecognized `status` string is still kept — it renders as an "Unknown"
 *  pill rather than being silently discarded. */
function parseEnrichmentEntries(data: OutreachContact["enrichmentData"]): EnrichmentLogEntry[] {
  if (!isRecord(data)) return [];
  const entries: EnrichmentLogEntry[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!isRecord(value)) continue;
    entries.push({
      providerKey: key,
      status: typeof value.status === "string" ? value.status : null,
      fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : null,
    });
  }
  return entries;
}

export function ContactEnrichmentPanel({ contact }: { contact: OutreachContact }) {
  const fields = [contact.email, contact.phone, contact.title, contact.linkedinUrl];
  const filledCount = fields.filter((v) => typeof v === "string" && v.trim().length > 0).length;
  const totalCount = fields.length;
  const pct = totalCount === 0 ? 0 : Math.round((filledCount / totalCount) * 100);

  const entries = parseEnrichmentEntries(contact.enrichmentData);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border-subtle bg-background-body p-3 flex flex-col gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">Data Completeness</span>
        <div className="determinate-progress-track">
          <div className="determinate-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-text-muted">
          {filledCount} of {totalCount} fields filled in
        </p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-background-body p-3 flex flex-col gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-text-secondary">Enrichment Log</span>
        {entries.length === 0 ? (
          <p className="text-sm text-text-muted italic">No enrichment attempted yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {entries.map((entry) => {
              const providerLabel =
                ENRICHMENT_PROVIDER_LABELS[entry.providerKey as keyof typeof ENRICHMENT_PROVIDER_LABELS] ??
                entry.providerKey;
              const statusConfig =
                entry.status && entry.status in ENRICHMENT_STATUS_CONFIG
                  ? ENRICHMENT_STATUS_CONFIG[entry.status as keyof typeof ENRICHMENT_STATUS_CONFIG]
                  : null;
              return (
                <div key={entry.providerKey} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium text-text-main">{providerLabel}</span>
                    <span
                      className={cn(
                        "px-2 py-0.5 rounded-full border text-[10px] font-medium",
                        statusConfig ? statusConfig.bg : "bg-gray-100",
                        statusConfig ? statusConfig.border : "border-gray-200",
                        statusConfig ? statusConfig.text : "text-gray-500",
                      )}
                    >
                      {statusConfig ? statusConfig.label : "Unknown"}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted">
                    {statusConfig ? statusConfig.description : "Unrecognized enrichment data."}
                  </p>
                  {isValidDateString(entry.fetchedAt) && (
                    <p className="text-[11px] text-text-muted">{formatRelativeTime(entry.fetchedAt)}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

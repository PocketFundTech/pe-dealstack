"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatters";

export type IntegrationActivityType = "MEETING" | "EMAIL" | "CALENDAR_EVENT" | string;

interface AiExtraction {
  summary?: string;
  actionItems?: string[];
  decisions?: string[];
  openQuestions?: string[];
  mentionedNumbers?: { label: string; value: string }[];
  sentiment?: string;
}

export interface IntegrationActivityRow {
  id: string;
  source: string;
  externalId: string;
  type: IntegrationActivityType;
  dealIds?: string[];
  contactIds?: string[];
  title?: string | null;
  summary?: string | null;
  occurredAt: string;
  durationSeconds?: number | null;
  metadata?: Record<string, unknown> | null;
  aiExtraction?: AiExtraction | null;
  createdAt: string;
}

interface Props {
  dealId?: string;
  contactId?: string;
  limit?: number;
}

const SOURCE_META: Record<string, { icon: string; label: string }> = {
  granola:         { icon: "mic",   label: "Granola" },
  gmail:           { icon: "mail",  label: "Gmail" },
  google_calendar: { icon: "event", label: "Calendar" },
  fireflies:       { icon: "mic",   label: "Fireflies" },
  otter:           { icon: "graphic_eq", label: "Otter" },
};

export function IntegrationActivityFeed({ dealId, contactId, limit = 25 }: Props) {
  const [rows, setRows] = useState<IntegrationActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const params = new URLSearchParams();
      if (dealId) params.set("dealId", dealId);
      if (contactId) params.set("contactId", contactId);
      params.set("limit", String(limit));
      try {
        const res = await api.get<{ activities: IntegrationActivityRow[] }>(
          `/integrations/activities?${params}`,
        );
        if (!cancelled) setRows(res.activities ?? []);
      } catch (err) {
        if (!cancelled) {
          console.warn("[IntegrationActivityFeed] load failed:", err);
          setError(err instanceof Error ? err.message : "Failed to load");
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (dealId || contactId) load();
    else setLoading(false);
    return () => {
      cancelled = true;
    };
  }, [dealId, contactId, limit]);

  if (loading) {
    return (
      <div className="text-sm text-text-muted py-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
        Loading synced meetings, emails, and events…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-text-muted py-4">
        Could not load synced activity. {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-sm text-text-muted py-4 border border-dashed border-border-subtle rounded-lg p-4">
        Nothing synced yet.{" "}
        <Link href="/settings#section-integrations" className="font-semibold" style={{ color: "#003366" }}>
          Connect a tool in Settings → Integrations
        </Link>{" "}
        to auto-import meetings, emails, and calendar events linked to this {dealId ? "deal" : "contact"}.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <ActivityRow key={row.id} row={row} />
      ))}
    </ul>
  );
}

function ActivityRow({ row }: { row: IntegrationActivityRow }) {
  const [open, setOpen] = useState(false);
  const meta = SOURCE_META[row.source] ?? { icon: "extension", label: row.source };
  const hasExtraction =
    row.aiExtraction &&
    Object.values(row.aiExtraction).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));

  return (
    <li className="border border-border-subtle rounded-lg p-3 bg-white">
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: "#E6EEF5", color: "#003366" }}
        >
          <span className="material-symbols-outlined text-[20px]">{meta.icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="font-semibold uppercase tracking-wide">{meta.label}</span>
            <span>·</span>
            <span>{formatRelativeTime(row.occurredAt)}</span>
          </div>
          <div className="text-sm font-semibold text-text-main mt-0.5 truncate">
            {row.title || "(no subject)"}
          </div>
          {row.summary && (
            <p className="text-sm text-text-secondary mt-1 line-clamp-3">{row.summary}</p>
          )}
          {hasExtraction && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-2 text-xs font-semibold"
              style={{ color: "#003366" }}
            >
              {open ? "Hide AI summary" : "Show AI summary"}
            </button>
          )}
          {open && row.aiExtraction && <AiExtractionPanel extraction={row.aiExtraction} />}
        </div>
      </div>
    </li>
  );
}

function AiExtractionPanel({ extraction }: { extraction: AiExtraction }) {
  return (
    <div className="mt-3 grid gap-3 text-sm bg-gray-50 border border-border-subtle rounded-md p-3">
      {extraction.summary && (
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-text-secondary">Summary</div>
          <div className="text-sm text-text-main mt-0.5">{extraction.summary}</div>
        </div>
      )}
      {extraction.actionItems && extraction.actionItems.length > 0 && (
        <ListBlock label="Action items" items={extraction.actionItems} />
      )}
      {extraction.decisions && extraction.decisions.length > 0 && (
        <ListBlock label="Decisions" items={extraction.decisions} />
      )}
      {extraction.openQuestions && extraction.openQuestions.length > 0 && (
        <ListBlock label="Open questions" items={extraction.openQuestions} />
      )}
      {extraction.mentionedNumbers && extraction.mentionedNumbers.length > 0 && (
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-text-secondary">
            Mentioned numbers
          </div>
          <ul className="mt-1 text-sm text-text-main flex flex-wrap gap-x-4 gap-y-1">
            {extraction.mentionedNumbers.map((n, i) => (
              <li key={i}>
                <span className="font-medium">{n.label}:</span> {n.value}
              </li>
            ))}
          </ul>
        </div>
      )}
      {extraction.sentiment && (
        <div className="text-xs text-text-muted">
          Sentiment: <span className="font-semibold capitalize">{extraction.sentiment}</span>
        </div>
      )}
    </div>
  );
}

function ListBlock({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wider text-text-secondary">{label}</div>
      <ul className="mt-1 list-disc pl-5 text-sm text-text-main space-y-0.5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

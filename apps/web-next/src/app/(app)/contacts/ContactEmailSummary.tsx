"use client";

import { useState, useCallback } from "react";
import { api, NotFoundError } from "@/lib/api";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/cn";

// Contract: GET /contacts/:id/email-summary
interface EmailSummary {
  connected: boolean;
  threadCount: number;
  lastContact?: string | null;
  summary: string;
  highlights: string[];
}

export function ContactEmailSummary({ contactId }: { contactId: string }) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EmailSummary | null>(null);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<EmailSummary>(`/contacts/${contactId}/email-summary`);
      setData(res);
    } catch (err) {
      if (err instanceof NotFoundError) {
        // Endpoint not available yet — treat as empty rather than an error.
        setData(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to summarize emails");
      }
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [contactId]);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted">Email Summary</h4>
        <button
          onClick={loadSummary}
          disabled={loading}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-primary hover:bg-primary-light transition-colors disabled:opacity-50"
          title="Summarize your email threads with this contact"
        >
          <span className={cn("material-symbols-outlined text-[14px]", loading && "animate-spin")}>{loading ? "sync" : "mark_email_read"}</span>
          {loading ? "Summarizing..." : loaded ? "Refresh" : "Summarize emails"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-border-subtle bg-gray-50 text-sm text-text-muted">
          <span className="material-symbols-outlined text-[18px] animate-spin text-primary">sync</span>
          Reading recent email threads...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 p-3 rounded-lg border border-red-200 bg-red-50/60 text-sm text-red-600">
          <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">error</span>
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && data && !data.connected && (
        <p className="flex items-center gap-1.5 text-text-muted text-sm italic p-2">
          <span className="material-symbols-outlined text-[16px]">mail_lock</span>
          Connect Gmail to summarize emails
        </p>
      )}

      {!loading && !error && data && data.connected && (
        <div className="p-3 rounded-lg border border-primary/20 bg-blue-50/30">
          <div className="flex items-center gap-3 mb-2 text-[11px] text-text-muted font-medium">
            <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">forum</span>{data.threadCount} thread{data.threadCount !== 1 ? "s" : ""}</span>
            {data.lastContact && <span className="flex items-center gap-1"><span className="material-symbols-outlined text-[14px]">schedule</span>{formatRelativeTime(data.lastContact)}</span>}
          </div>
          {data.threadCount === 0 ? (
            <p className="text-sm text-text-muted italic">No email threads found with this contact.</p>
          ) : (
            <>
              {data.summary && <p className="text-sm text-text-secondary leading-relaxed">{data.summary}</p>}
              {data.highlights && data.highlights.length > 0 && (
                <ul className="flex flex-col gap-1.5 mt-3">
                  {data.highlights.map((h, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                      <span className="material-symbols-outlined text-[16px] text-primary shrink-0 mt-0.5">arrow_right</span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {!loading && !error && !data && loaded && (
        <p className="text-text-muted text-sm italic p-2">No summary available.</p>
      )}
    </div>
  );
}

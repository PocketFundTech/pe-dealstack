"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  STATUS_COLOR_CLASSES,
  STATUS_LABELS,
} from "@/app/(app)/nda/constants";
import type { LegalDocument } from "@/app/(app)/nda/types";

interface LegalDocsPanelProps {
  dealId: string;
}

/**
 * Compact list of NDAs / legal docs for the active deal — surfaced inside
 * the memo-builder outline so an analyst pulling together an IC memo can
 * see whether the legal side is moving without leaving the page.
 */
export function LegalDocsPanel({ dealId }: LegalDocsPanelProps) {
  const [docs, setDocs] = useState<LegalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    if (!dealId) {
      setDocs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.get<LegalDocument[]>(
        `/deals/${dealId}/legal-documents`,
      );
      setDocs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[memo-builder/legal-docs] load failed:", err);
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="bg-white rounded-lg p-3 border border-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-slate-700 hover:text-primary font-semibold text-xs"
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px]">gavel</span>
          <span>Legal docs for this deal</span>
        </div>
        <span
          className={cn(
            "material-symbols-outlined text-[16px] text-slate-400 transition-transform",
            open ? "rotate-180" : "",
          )}
        >
          expand_more
        </span>
      </button>

      {open && (
        <div className="mt-2">
          {loading ? (
            <div className="text-[11px] text-slate-400 py-2">Loading…</div>
          ) : docs.length === 0 ? (
            <div className="text-[11px] text-slate-500 leading-snug">
              No NDAs yet for this deal.{" "}
              <Link
                href={`/nda?dealId=${encodeURIComponent(dealId)}&create=1`}
                className="font-medium text-primary hover:underline"
              >
                Draft one →
              </Link>
            </div>
          ) : (
            <ul className="space-y-1.5 mt-1">
              {docs.map((d) => {
                const cls = STATUS_COLOR_CLASSES[d.status];
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-2 min-w-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-slate-700 truncate font-medium">
                        {d.title}
                      </div>
                      {d.counterpartyName && (
                        <div className="text-[10px] text-slate-400 truncate">
                          {d.counterpartyName}
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        "text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0",
                        cls.bg,
                        cls.text,
                        cls.border,
                      )}
                    >
                      {STATUS_LABELS[d.status]}
                    </span>
                    <Link
                      href="/nda"
                      className="text-[10px] font-semibold text-primary hover:underline shrink-0"
                    >
                      Open
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

// Read-only external portal view of a shared deal. Pure render component —
// data fetching lives in [token]/page.tsx so this stays unit-testable.

import DOMPurify from "dompurify";
import { useState } from "react";
import Link from "next/link";
import { formatCurrency, formatPercent } from "@/lib/formatters";
import { STAGE_LABELS } from "@/lib/constants";
import { PortalFinancials, type PortalStatement } from "./portal-financials";

// Same allowlist approach as memo-builder/editor.tsx's sanitizeHtml — memo
// content is stored as HTML; strip everything unsafe before rendering.
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "b", "i", "br", "div", "span", "table", "thead", "tbody", "tr", "th", "td", "a", "blockquote", "code", "pre"],
    ALLOWED_ATTR: ["class", "href", "target", "rel", "title"],
  });
}

export interface PortalPayload {
  share: {
    label: string | null;
    sharedBy: string;
    /** When the link was created (ISO) — shown in the footer. */
    sharedAt?: string | null;
    includeFinancials: boolean;
    includeDocuments: boolean;
    includeMemos: boolean;
  };
  deal: {
    name: string;
    companyName?: string | null;
    industry?: string | null;
    stage?: string | null;
    description?: string | null;
    dealSize?: number | null;
    revenue?: number | null;
    ebitda?: number | null;
    currency?: string | null;
  };
  financials?: PortalStatement[];
  documents?: Array<{ id: string; name: string; type?: string | null; fileSize?: number | null }>;
  memos?: Array<{ id: string; title: string; sections: Array<{ title: string; content: string }> }>;
}

export type PortalState =
  | { status: "loading" }
  | { status: "gone"; message: string }
  | { status: "notfound" }
  | { status: "ready"; payload: PortalPayload };

type TabId = "financials" | "documents" | "memos";

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-3 sm:p-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="text-lg sm:text-xl font-bold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

function CenteredMessage({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <h1 className="text-xl font-bold mb-2" style={{ color: "#003366" }}>{title}</h1>
        <p className="text-sm text-gray-500">{text}</p>
      </div>
    </div>
  );
}

/**
 * Read-only external view of a shared deal (QA #25c redesign): firm + deal
 * header with a stage badge, Revenue / EBITDA / Margin / Deal size cards,
 * tabs for whatever the share includes, mobile-first layout, and a
 * "Shared by {firm} on {date}" footer.
 */
export function PortalView({ state, token }: { state: PortalState; token: string }) {
  const [tab, setTab] = useState<TabId | null>(null);

  if (state.status === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">Loading deal...</div>;
  }
  if (state.status === "gone") return <CenteredMessage title="This link is no longer active" text={state.message} />;
  if (state.status === "notfound") {
    return <CenteredMessage title="Link not found" text="Check the link you were sent, or ask the sender for a new one." />;
  }

  const { share, deal, financials, documents, memos } = state.payload;
  const cur = deal.currency ?? undefined;
  const margin = deal.revenue && deal.ebitda != null ? (deal.ebitda / deal.revenue) * 100 : null;
  const stageLabel = deal.stage ? STAGE_LABELS[deal.stage] ?? deal.stage.replace(/_/g, " ") : null;
  const sharedOn = share.sharedAt
    ? new Date(share.sharedAt).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })
    : null;

  const tabs: { id: TabId; label: string; count?: number }[] = [];
  if (financials && financials.length > 0) tabs.push({ id: "financials", label: "Financials" });
  if (documents && documents.length > 0) tabs.push({ id: "documents", label: "Documents", count: documents.length });
  if (memos && memos.length > 0) tabs.push({ id: "memos", label: "Memos", count: memos.length });
  const active = tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id ?? null;

  return (
    <div className="min-h-screen bg-[#F8F9FA] flex flex-col">
      {/* Header: firm → deal → stage */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-xs font-semibold text-gray-500 truncate">{share.sharedBy}</span>
            <span className="shrink-0 px-2 py-0.5 rounded-md bg-blue-50 border border-blue-200 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#003366" }}>
              Read-only
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl sm:text-2xl font-bold" style={{ color: "#003366" }}>{deal.name}</h1>
            {stageLabel && (
              <span className="px-2 py-0.5 rounded-full bg-[#E6EDF5] text-[11px] font-semibold" style={{ color: "#003366" }}>
                {stageLabel}
              </span>
            )}
          </div>
          {(deal.companyName || deal.industry) && (
            <p className="text-sm text-gray-500 mt-1">
              {[deal.companyName, deal.industry].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6 space-y-5">
        {/* Key metrics */}
        <section aria-label="Key metrics" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="Revenue" value={deal.revenue != null ? formatCurrency(deal.revenue, cur) : "—"} />
          <MetricCard label="EBITDA" value={deal.ebitda != null ? formatCurrency(deal.ebitda, cur) : "—"} />
          <MetricCard label="EBITDA margin" value={margin != null && Number.isFinite(margin) ? formatPercent(margin) : "—"} />
          <MetricCard label="Deal size" value={deal.dealSize != null ? formatCurrency(deal.dealSize, cur) : "—"} />
        </section>

        {deal.description && (
          <section className="bg-white rounded-lg border border-gray-200 p-4 sm:p-5">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-2">About</h2>
            <p className="text-sm text-gray-700 whitespace-pre-line">{deal.description}</p>
          </section>
        )}

        {tabs.length > 0 && (
          <section className="bg-white rounded-lg border border-gray-200">
            <div role="tablist" aria-label="Shared sections" className="flex gap-1 border-b border-gray-200 px-2 sm:px-3 overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active === t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-3 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors ${active === t.id ? "border-[#003366] text-[#003366]" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                >
                  {t.label}
                  {t.count != null && <span className="ml-1.5 text-xs font-medium text-gray-400">{t.count}</span>}
                </button>
              ))}
            </div>

            <div role="tabpanel" className="p-4 sm:p-5">
              {active === "financials" && financials && <PortalFinancials statements={financials} currency={deal.currency} />}

              {active === "documents" && documents && (
                <ul className="divide-y divide-gray-100">
                  {documents.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">{d.name}</div>
                        {d.fileSize != null && (
                          <div className="text-[11px] text-gray-500">{(d.fileSize / 1024).toFixed(0)} KB</div>
                        )}
                      </div>
                      <a
                        href={`/api/public/portal/${token}/documents/${d.id}/download`}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold text-white shrink-0"
                        style={{ backgroundColor: "#003366" }}
                      >
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              )}

              {active === "memos" && memos && (
                <div className="space-y-6">
                  {memos.map((m) => (
                    <article key={m.id}>
                      <h3 className="text-base font-bold text-gray-900 mb-2">{m.title}</h3>
                      <div className="space-y-3">
                        {m.sections.map((s, i) => (
                          <div key={i}>
                            <h4 className="text-sm font-semibold text-gray-700 mb-1">{s.title}</h4>
                            <div
                              className="prose prose-sm max-w-none text-gray-700"
                              // Sanitized: DOMPurify allowlist — never raw HTML.
                              dangerouslySetInnerHTML={{ __html: sanitizeHtml(s.content || "") }}
                            />
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-gray-500">
          <span>
            Shared by <span className="font-semibold text-gray-700">{share.sharedBy}</span>
            {sharedOn && <> on {sharedOn}</>} · Read-only view
          </span>
          <span>
            Powered by <Link href="/" className="font-semibold" style={{ color: "#003366" }}>Avise</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}

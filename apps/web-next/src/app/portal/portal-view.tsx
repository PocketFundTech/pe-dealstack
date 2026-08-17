"use client";

// Read-only external portal view of a shared deal. Pure render component —
// data fetching lives in [token]/page.tsx so this stays unit-testable.

import DOMPurify from "dompurify";
import Link from "next/link";
import { formatCurrency } from "@/lib/formatters";

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
  financials?: Array<{ statementType: string; period: string; lineItems: Record<string, number> }>;
  documents?: Array<{ id: string; name: string; type?: string | null; fileSize?: number | null }>;
  memos?: Array<{ id: string; title: string; sections: Array<{ title: string; content: string }> }>;
}

export type PortalState =
  | { status: "loading" }
  | { status: "gone"; message: string }
  | { status: "notfound" }
  | { status: "ready"; payload: PortalPayload };

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-md border border-gray-200 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-bold text-gray-900">{value}</div>
    </div>
  );
}

export function PortalView({ state, token }: { state: PortalState; token: string }) {
  if (state.status === "loading") {
    return <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">Loading deal...</div>;
  }
  if (state.status === "gone") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-bold mb-2" style={{ color: "#003366" }}>This link is no longer active</h1>
          <p className="text-sm text-gray-500">{state.message}</p>
        </div>
      </div>
    );
  }
  if (state.status === "notfound") {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-bold mb-2" style={{ color: "#003366" }}>Link not found</h1>
          <p className="text-sm text-gray-500">Check the link you were sent, or ask the sender for a new one.</p>
        </div>
      </div>
    );
  }

  const { share, deal, financials, documents, memos } = state.payload;

  return (
    <div className="min-h-screen bg-[#F8F9FA]">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold" style={{ color: "#003366" }}>{deal.name}</h1>
            <p className="text-xs text-gray-500">Shared by {share.sharedBy} via PE OS</p>
          </div>
          <span className="px-2 py-1 rounded-md bg-blue-50 border border-blue-200 text-[10px] font-bold uppercase tracking-wider" style={{ color: "#003366" }}>
            Read-only
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        {/* Overview */}
        <section className="bg-white rounded-lg border border-gray-200 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Overview</h2>
          {deal.description && <p className="text-sm text-gray-700 mb-4">{deal.description}</p>}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {deal.industry && <Metric label="Industry" value={deal.industry} />}
            {deal.dealSize != null && <Metric label="Deal size" value={formatCurrency(deal.dealSize, deal.currency ?? undefined)} />}
            {deal.revenue != null && <Metric label="Revenue" value={formatCurrency(deal.revenue, deal.currency ?? undefined)} />}
            {deal.ebitda != null && <Metric label="EBITDA" value={formatCurrency(deal.ebitda, deal.currency ?? undefined)} />}
          </div>
        </section>

        {/* Financials */}
        {financials && financials.length > 0 && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Financials</h2>
            <div className="space-y-4">
              {financials.map((s, i) => (
                <div key={i}>
                  <div className="text-xs font-semibold text-gray-700 mb-1">{s.statementType} — {s.period}</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <tbody>
                        {Object.entries(s.lineItems || {}).map(([label, value]) => (
                          <tr key={label} className="border-t border-gray-100">
                            <td className="py-1.5 text-gray-600">{label}</td>
                            <td className="py-1.5 text-right font-medium text-gray-900">
                              {typeof value === "number" ? formatCurrency(value, deal.currency ?? undefined) : String(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Documents */}
        {documents && documents.length > 0 && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Documents</h2>
            <ul className="divide-y divide-gray-100">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2.5">
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
          </section>
        )}

        {/* Memos */}
        {memos && memos.length > 0 && (
          <section className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500 mb-3">Memos</h2>
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
          </section>
        )}
      </main>

      <footer className="max-w-4xl mx-auto px-6 pb-8 text-center text-[11px] text-gray-400">
        Powered by <Link href="/" className="font-semibold" style={{ color: "#003366" }}>PE OS</Link> — deal management for private equity teams
      </footer>
    </div>
  );
}

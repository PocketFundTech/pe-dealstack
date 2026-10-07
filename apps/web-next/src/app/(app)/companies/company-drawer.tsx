"use client";

import Link from "next/link";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import { STAGE_LABELS } from "@/lib/constants";
import { CompanyOverview, SOURCE_LABELS, websiteHref, websiteLabel } from "./companies-shared";

// Right-hand drawer for one company — same shell as the Contacts detail panel.
// Read-only: fields, live deals (links) and contacts whose company name matches.

export function SourceBadge({ source }: { source: "hubspot" | "avise" }) {
  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded-md text-[10px] font-bold uppercase",
        source === "hubspot" ? "bg-orange-50 text-orange-700" : "bg-primary-light text-primary",
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-text-muted uppercase tracking-wider">{label}</span>
      <span className="text-sm text-text-main break-words">{children}</span>
    </div>
  );
}

export function CompanyDrawer({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { data, error, isLoading } = useApiQuery<CompanyOverview>(`/companies/${companyId}/overview`);

  const shell = (title: string, body: React.ReactNode) => (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} data-testid="company-drawer-backdrop" />
      <div
        role="dialog"
        aria-label={title}
        className="right-drawer fixed top-0 right-0 h-full w-[450px] max-w-full bg-surface-card shadow-2xl z-50 flex flex-col border-l border-border-subtle"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle shrink-0">
          <h2 className="text-lg font-bold text-text-main truncate">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        {body}
      </div>
    </>
  );

  if (isLoading) {
    return shell(
      "Company",
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center">
          <span className="material-symbols-outlined text-primary text-3xl animate-spin mb-3">sync</span>
          <p className="text-text-muted text-sm">Loading company...</p>
        </div>
      </div>,
    );
  }

  if (error || !data) {
    return shell(
      "Company",
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <span className="material-symbols-outlined text-red-500 text-3xl mb-3">error</span>
        <p className="text-text-main font-medium">Couldn&apos;t load this company</p>
        <p className="text-text-muted text-sm mt-1">{error?.message}</p>
      </div>,
    );
  }

  const { company, deals, contacts, contactTotal } = data;
  const href = websiteHref(company.website);

  return shell(
    company.name,
    <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
      <div className="flex items-center gap-2 flex-wrap">
        <SourceBadge source={company.source} />
        {company.updatedAt && (
          <span className="text-xs text-text-muted">Updated {formatRelativeTime(company.updatedAt)}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Industry">{company.industry || "--"}</Field>
        <Field label="Website">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              {websiteLabel(company.website)}
            </a>
          ) : (
            company.website || "--"
          )}
        </Field>
      </div>
      {company.description && <Field label="Description">{company.description}</Field>}

      <section>
        <h3 className="text-sm font-bold text-text-main mb-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-text-muted text-[18px]">work</span>
          Deals <span className="text-text-muted font-medium">({deals.length})</span>
        </h3>
        {deals.length === 0 ? (
          <p className="text-sm text-text-muted">No deals for this company yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle border border-border-subtle rounded-lg">
            {deals.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/deals/${d.id}`}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50/80 transition-colors"
                >
                  <span className="text-sm font-medium text-text-main truncate">{d.name || "Untitled deal"}</span>
                  {d.stage && (
                    <span className="text-[11px] text-text-muted whitespace-nowrap">{STAGE_LABELS[d.stage] ?? d.stage}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-bold text-text-main mb-2 flex items-center gap-2">
          <span className="material-symbols-outlined text-text-muted text-[18px]">groups</span>
          Contacts <span className="text-text-muted font-medium">({contactTotal})</span>
        </h3>
        {contacts.length === 0 ? (
          <p className="text-sm text-text-muted">No contacts list this company.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle border border-border-subtle rounded-lg">
            {contacts.map((c) => (
              <li key={c.id} className="px-3 py-2.5">
                <p className="text-sm font-medium text-text-main truncate">
                  {[c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unnamed contact"}
                </p>
                {(c.title || c.email) && (
                  <p className="text-xs text-text-muted truncate">{[c.title, c.email].filter(Boolean).join(" · ")}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {contactTotal > contacts.length && (
          <p className="text-xs text-text-muted mt-2">
            Showing {contacts.length} of {contactTotal}. See all on the <Link href="/contacts" className="text-primary hover:underline">Contacts</Link> page.
          </p>
        )}
        <p className="text-[11px] text-text-muted mt-2">Contacts are matched by the company name on the contact.</p>
      </section>
    </div>,
  );
}

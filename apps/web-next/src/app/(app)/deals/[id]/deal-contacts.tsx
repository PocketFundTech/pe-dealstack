"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface DealContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  title: string | null;
  company: string | null;
  role: string;
}

const ROLE_LABELS: Record<string, string> = {
  BANKER: "Banker",
  ADVISOR: "Advisor",
  BOARD_MEMBER: "Board member",
  MANAGEMENT: "Management",
  OTHER: "Contact",
};

/** Contacts linked to a deal (from a contact's page, or the HubSpot import). */
export function DealContactsSection({ dealId }: { dealId: string }) {
  const [contacts, setContacts] = useState<DealContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = useCallback(
    () =>
      api.get<{ contacts: DealContact[] }>(`/deals/${dealId}/contacts`)
        .then((r) => { setContacts(r.contacts ?? []); setError(null); })
        .catch((err) => setError(err instanceof Error && err.message ? err.message : "The server didn't answer.")),
    [dealId],
  );

  useEffect(() => { void fetchContacts(); }, [fetchContacts]);

  return (
    <section className="rounded-lg border border-border-subtle bg-white p-4 shadow-card">
      <div className="mb-2 flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-[#003366]">group</span>
        <h3 className="text-sm font-semibold text-text-main">
          Contacts{contacts && contacts.length > 0 ? ` (${contacts.length})` : ""}
        </h3>
      </div>

      {error ? (
        <div className="text-sm">
          <p className="text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => { setError(null); void fetchContacts(); }}
            className="mt-1 text-xs font-semibold text-[#003366] hover:underline"
          >
            Retry
          </button>
        </div>
      ) : contacts === null ? (
        <p className="text-sm text-text-muted">Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="text-sm text-text-muted">
          No contacts linked to this deal yet. Link one from a contact&apos;s page, or import them from HubSpot.
        </p>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {contacts.map((c) => {
            const name = `${c.firstName} ${c.lastName}`.trim() || c.email || "Unnamed contact";
            const sub = [c.title, c.company].filter(Boolean).join(" · ");
            return (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">{name}</p>
                  {sub && <p className="truncate text-xs text-text-muted">{sub}</p>}
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="text-xs text-[#003366] hover:underline">{c.email}</a>
                  )}
                </div>
                <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-semibold text-text-secondary">
                  {ROLE_LABELS[c.role] ?? c.role}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

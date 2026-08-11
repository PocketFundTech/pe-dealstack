"use client";

// Share-deal modal — create/list/revoke external portal links for a deal.
// Owner-side counterpart of the public /portal/[token] page.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface ShareRow {
  id: string;
  label: string | null;
  invitedEmail: string | null;
  url: string;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

const EXPIRY_OPTIONS = [
  { label: "Never expires", value: 0 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

export function ShareDealModal({
  dealId,
  dealName,
  onClose,
}: {
  dealId: string;
  dealName: string;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [label, setLabel] = useState("");
  const [invitedEmail, setInvitedEmail] = useState("");
  const [includeFinancials, setIncludeFinancials] = useState(true);
  const [includeDocuments, setIncludeDocuments] = useState(true);
  const [includeMemos, setIncludeMemos] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadShares = async () => {
    try {
      const data = await api.get<{ shares: ShareRow[] }>(`/deals/${dealId}/shares`);
      setShares(data.shares.filter((s) => !s.revokedAt));
    } catch (err) {
      console.warn("share list load failed", err);
    }
  };

  useEffect(() => {
    loadShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  const createShare = async () => {
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { includeFinancials, includeDocuments, includeMemos };
      if (label.trim()) body.label = label.trim();
      if (invitedEmail.trim()) body.invitedEmail = invitedEmail.trim();
      if (expiresInDays > 0) body.expiresInDays = expiresInDays;
      const result = await api.post<{ share: { id: string }; url: string }>(`/deals/${dealId}/shares`, body);
      setCreatedUrl(result.url);
      setLabel("");
      setInvitedEmail("");
      await loadShares();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create share link");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (shareId: string) => {
    try {
      await api.delete(`/deals/${dealId}/shares/${shareId}`);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke");
    }
  };

  const copy = async () => {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("clipboard copy failed", err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold" style={{ color: "#003366" }}>Share deal</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Create a private, revocable read-only link to <span className="font-semibold">{dealName}</span>. Anyone with the link can view — don&apos;t forward it.
        </p>

        {/* Create form */}
        <div className="space-y-3 mb-4">
          <input
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            placeholder='Label, e.g. "Healthcare partner" (optional)'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
            placeholder="client@firm.com (optional)"
            value={invitedEmail}
            onChange={(e) => setInvitedEmail(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={includeFinancials} onChange={(e) => setIncludeFinancials(e.target.checked)} aria-label="Financials" />
              Financials
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={includeDocuments} onChange={(e) => setIncludeDocuments(e.target.checked)} aria-label="Documents" />
              Documents
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={includeMemos} onChange={(e) => setIncludeMemos(e.target.checked)} aria-label="Memos" />
              Memos
            </label>
            <select
              className="ml-auto rounded-md border border-gray-200 px-2 py-1.5 text-xs text-gray-700"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <button
            onClick={createShare}
            disabled={creating}
            className="w-full py-2 rounded-md text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: "#003366" }}
          >
            {creating ? "Creating..." : "Create link"}
          </button>
          {error && <p className="text-xs text-red-600">{error}</p>}
          {createdUrl && (
            <div className="flex items-center gap-2">
              <input readOnly value={createdUrl} className="flex-1 rounded-md border border-gray-200 px-3 py-2 text-xs bg-gray-50" />
              <button onClick={copy} className="px-3 py-2 rounded-md text-xs font-semibold border border-gray-200 hover:border-[#003366]" style={{ color: "#003366" }}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </div>

        {/* Existing shares */}
        {shares.length > 0 && (
          <div>
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Active links</h3>
            <ul className="divide-y divide-gray-100">
              {shares.map((s) => (
                <li key={s.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {s.label || s.invitedEmail || "Untitled link"}
                    </div>
                    <div className="text-[11px] text-gray-500">
                      {s.viewCount} views{s.lastViewedAt ? ` · last ${new Date(s.lastViewedAt).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(s.id)}
                    className="px-2.5 py-1.5 rounded-md text-xs font-semibold text-red-600 border border-red-200 hover:bg-red-50 shrink-0"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

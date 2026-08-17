"use client";

// Owner-side document requests, rendered inside the deal's Documents tab.
// Two pieces: the "Request documents" modal (pick a template, edit the
// checklist, address it) and the list of live requests with per-item
// status, copy-link, remind and revoke.
//
// Lives beside the Documents tab rather than behind its own top-level tab
// on purpose — asking for documents and receiving them are the same job,
// and TABS in deal-detail-shared.ts is deliberately short.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";

interface RequestItem {
  id: string;
  label: string;
  docType: string | null;
  notes: string | null;
  required: boolean;
  sortOrder: number;
  documentId: string | null;
  fulfilledAt: string | null;
}

interface DocRequest {
  id: string;
  token: string;
  url: string;
  recipientEmail: string | null;
  recipientName: string | null;
  message: string | null;
  status: "OPEN" | "PARTIAL" | "FULFILLED" | "CANCELLED";
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastRemindedAt: string | null;
  reminderCount: number;
  completedAt: string | null;
  items: RequestItem[];
  receivedCount: number;
  totalCount: number;
  viewCount: number;
}

const TEMPLATES = [
  { key: "STANDARD_DD", label: "Standard DD package", hint: "13 items — the usual first ask" },
  { key: "FINANCIALS_ONLY", label: "Financials only", hint: "6 items — P&L, BS, CF, add-backs" },
  { key: "QOE_PREP", label: "Quality of earnings prep", hint: "6 items — bank + processor data" },
  { key: "LEGAL_CORPORATE", label: "Legal & corporate", hint: "6 items — cap table, contracts" },
] as const;

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  OPEN: { bg: "bg-amber-50", text: "text-amber-700", label: "Waiting" },
  PARTIAL: { bg: "bg-blue-50", text: "text-blue-700", label: "Partially received" },
  FULFILLED: { bg: "bg-green-50", text: "text-green-700", label: "Complete" },
  CANCELLED: { bg: "bg-gray-100", text: "text-gray-600", label: "Revoked" },
};

interface DraftItem {
  label: string;
  required: boolean;
  notes?: string;
  docType?: string;
}

function RequestModal({
  dealId,
  onClose,
  onCreated,
}: {
  dealId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { showToast } = useToast();
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [items, setItems] = useState<DraftItem[]>([]);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Templates come from the server so the checklist has one definition.
  // Fetched once on open; picking a template is then instant.
  const [templates, setTemplates] = useState<Record<string, DraftItem[]>>({});
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ templates: Record<string, DraftItem[]> }>(
          `/deals/${dealId}/doc-requests/templates`,
        );
        setTemplates(res.templates);
      } catch (err) {
        // Leave templates empty — the user can still send the bare key and
        // let the server expand it, or add items by hand.
        console.warn("doc-request templates fetch failed", err);
      }
    })();
  }, [dealId]);

  const pickTemplate = useCallback(
    (key: string) => {
      setTemplateKey(key);
      // Expanded locally from the fetched definitions so the user can edit
      // before anything is persisted. The server re-expands on create when
      // no explicit items are sent.
      setItems(templates[key] ? templates[key].map((i) => ({ ...i })) : []);
    },
    [templates],
  );

  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      await api.post(`/deals/${dealId}/doc-requests`, {
        ...(items.length > 0 ? { items } : { templateKey }),
        ...(recipientEmail ? { recipientEmail } : {}),
        ...(recipientName ? { recipientName } : {}),
        ...(message ? { message } : {}),
      });
      showToast(
        recipientEmail ? `Request sent to ${recipientEmail}` : "Request link created",
        "success",
      );
      onCreated();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't create the request", "error");
    } finally {
      setSubmitting(false);
    }
  }, [dealId, items, templateKey, recipientEmail, recipientName, message, showToast, onCreated, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
          <h3 className="text-base font-semibold text-text-main">Request documents</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="flex flex-col gap-5 px-6 py-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-main">
              What do you need?
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => pickTemplate(t.key)}
                  className="rounded-lg border px-3 py-2.5 text-left transition-colors"
                  style={{
                    borderColor: templateKey === t.key ? "#003366" : "#E5E7EB",
                    backgroundColor: templateKey === t.key ? "rgba(0,51,102,0.04)" : "#fff",
                  }}
                >
                  <span className="block text-sm font-medium text-text-main">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {items.length > 0 && (
            <div>
              <label className="mb-2 block text-sm font-medium text-text-main">
                Checklist ({items.length})
              </label>
              <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto rounded-lg border border-border-subtle p-2">
                {items.map((item, idx) => (
                  <li key={idx} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-gray-50">
                    <input
                      value={item.label}
                      onChange={(e) =>
                        setItems((list) =>
                          list.map((it, i) => (i === idx ? { ...it, label: e.target.value } : it)),
                        )
                      }
                      className="min-w-0 flex-1 border-0 bg-transparent text-sm text-text-main focus:outline-none"
                    />
                    <button
                      onClick={() => setItems((list) => list.filter((_, i) => i !== idx))}
                      className="text-text-muted hover:text-red-600"
                      aria-label={`Remove ${item.label}`}
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => setItems((list) => [...list, { label: "", required: false }])}
                className="mt-2 text-xs font-medium text-[#003366] hover:underline"
              >
                + Add an item
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-text-main">
                Send to <span className="font-normal text-text-muted">(optional)</span>
              </label>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                placeholder="broker@example.com"
                className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-text-main">Their name</label>
              <input
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
                placeholder="Dana"
                className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-text-main">
              Note <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Happy to sign an NDA first if that's easier."
              className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:border-[#003366] focus:outline-none"
            />
          </div>

          <p className="text-xs text-text-muted">
            They&rsquo;ll get a link that opens straight to an upload page — no account, no password.
            Files land in this deal&rsquo;s data room automatically.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting || (!templateKey && items.length === 0)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {submitting ? "Creating…" : recipientEmail ? "Send request" : "Create link"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DocRequestsPanel({ dealId }: { dealId: string }) {
  const { showToast } = useToast();
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ requests: DocRequest[] }>(`/deals/${dealId}/doc-requests`);
      setRequests(res.requests);
    } catch (err) {
      // Endpoint missing (migration not yet applied) — show the empty state
      // rather than an error the user can't act on.
      console.warn("doc requests load failed", err);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyLink = useCallback(
    async (url: string) => {
      await navigator.clipboard.writeText(url);
      showToast("Link copied", "success");
    },
    [showToast],
  );

  const remind = useCallback(
    async (requestId: string) => {
      try {
        await api.post(`/deals/${dealId}/doc-requests/${requestId}/remind`, {});
        showToast("Reminder sent", "success");
        void load();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Couldn't send the reminder", "error");
      }
    },
    [dealId, showToast, load],
  );

  const revoke = useCallback(
    async (requestId: string) => {
      try {
        await api.delete(`/deals/${dealId}/doc-requests/${requestId}`);
        showToast("Link revoked", "success");
        void load();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Couldn't revoke the link", "error");
      }
    },
    [dealId, showToast, load],
  );

  const active = requests.filter((r) => !r.revokedAt);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-main">
          Document requests{active.length > 0 ? ` (${active.length})` : ""}
        </h3>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-white px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-50"
        >
          <span className="material-symbols-outlined text-[18px]">outgoing_mail</span>
          Request documents
        </button>
      </div>

      {!loading && active.length === 0 && (
        <div className="rounded-lg border border-dashed border-border-subtle px-4 py-6 text-center">
          <p className="text-sm text-text-muted">No open requests</p>
          <p className="mt-1 text-xs text-text-muted">
            Ask a broker or seller for what&rsquo;s missing — they upload without an account.
          </p>
        </div>
      )}

      {active.map((req) => {
        const style = STATUS_STYLES[req.status] ?? STATUS_STYLES.OPEN;
        const isOpen = expanded === req.id;
        return (
          <div key={req.id} className="rounded-lg border border-border-subtle bg-white">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <button
                onClick={() => setExpanded(isOpen ? null : req.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="material-symbols-outlined text-[18px] text-text-muted">
                  {isOpen ? "expand_more" : "chevron_right"}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-main">
                    {req.recipientEmail || "Shareable link"}
                  </p>
                  <p className="text-xs text-text-muted">
                    {req.receivedCount} of {req.totalCount} received
                    {req.viewCount > 0 && ` · opened ${req.viewCount}×`}
                  </p>
                </div>
              </button>

              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}>
                {style.label}
              </span>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void copyLink(req.url)}
                  title="Copy link"
                  className="rounded p-1.5 text-text-muted hover:bg-gray-50 hover:text-text-main"
                >
                  <span className="material-symbols-outlined text-[18px]">link</span>
                </button>
                {req.recipientEmail && req.status !== "FULFILLED" && (
                  <button
                    onClick={() => void remind(req.id)}
                    title="Send a reminder"
                    className="rounded p-1.5 text-text-muted hover:bg-gray-50 hover:text-text-main"
                  >
                    <span className="material-symbols-outlined text-[18px]">notifications_active</span>
                  </button>
                )}
                <button
                  onClick={() => void revoke(req.id)}
                  title="Revoke this link"
                  className="rounded p-1.5 text-text-muted hover:bg-gray-50 hover:text-red-600"
                >
                  <span className="material-symbols-outlined text-[18px]">link_off</span>
                </button>
              </div>
            </div>

            {isOpen && (
              <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                {req.items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5 pl-11">
                    <span className="truncate text-sm text-text-secondary">
                      {item.label}
                      {!item.required && (
                        <span className="ml-1.5 text-xs text-text-muted">optional</span>
                      )}
                    </span>
                    {item.fulfilledAt ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-green-700">
                        <span className="material-symbols-outlined text-[16px]">check_circle</span>
                        Received
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-text-muted">Waiting</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {modalOpen && (
        <RequestModal dealId={dealId} onClose={() => setModalOpen(false)} onCreated={load} />
      )}
    </div>
  );
}

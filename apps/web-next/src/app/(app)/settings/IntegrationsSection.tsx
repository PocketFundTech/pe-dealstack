"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PasteKeyModal, type PasteKeyInstructions } from "./IntegrationsSection.PasteKeyModal";
import { ProviderCard, type Integration, type ProviderCatalogEntry } from "./IntegrationsSection.providerCard";

interface InitiateAuthResponse {
  mode: "oauth" | "api_key";
  authUrl?: string;
  state?: string;
  instructions?: PasteKeyInstructions;
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "granola",         name: "Granola",         desc: "Auto-import meeting transcripts",        icon: "mic",         available: true },
  { id: "gmail",           name: "Gmail",           desc: "Sync deal-related emails",               icon: "mail",        available: true },
  { id: "google_calendar", name: "Google",           desc: "Drive files, Calendar & NDA docs",       icon: "workspaces",  available: true },
  { id: "outlook",         name: "Outlook",          desc: "Sync deal-related emails",              icon: "mail",        available: true },
  // OneDrive file import isn't built yet (only calendar) — don't promise it.
  { id: "microsoft365",    name: "Microsoft 365",    desc: "Sync calendar events",                  icon: "workspaces",  available: true },
  { id: "fireflies",       name: "Fireflies",       desc: "Auto-import meeting transcripts",        icon: "mic",         available: false },
  { id: "otter",           name: "Otter",           desc: "Auto-import meeting transcripts",        icon: "graphic_eq",  available: false },
];

// ─── HubSpot types ──────────────────────────────────────────────────

interface HubSpotJobCounts {
  processed: number;
  created: number;
  updated: number;
  failed: number;
  skipped?: number;
}

interface HubSpotImportJob {
  id: string;
  status: string;
  currentObject: string | null;
  objectCounts: Record<string, HubSpotJobCounts>;
  error?: string | null;
}

const HUBSPOT_OBJECTS = ["companies", "contacts", "deals", "notes", "calls", "meetings", "emails", "tasks"] as const;

const POLL_TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * Safety bound on the client-driven continuation loop. Each round is up to ~4
 * minutes of server-side import work, so this covers far more than any
 * realistic portal — it exists only to stop a runaway loop if the server were
 * ever to keep reporting `more: true` without making progress.
 */
const MAX_CONTINUE_ROUNDS = 200;

// ────────────────────────────────────────────────────────────────────

interface Props {
  onToast: (message: string, type: "success" | "error" | "info") => void;
}

export function IntegrationsSection({ onToast }: Props) {
  const search = useSearchParams();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [pasteModal, setPasteModal] = useState<{ provider: string; instructions: PasteKeyInstructions } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<Integration | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ integrations: Integration[] }>("/integrations");
      setIntegrations(res.integrations ?? []);
    } catch (err) {
      console.warn("[settings/integrations] load failed:", err);
      setIntegrations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Surface OAuth callback result via toast (the API redirects here with
  // ?integrations=connected|error&provider=...).
  useEffect(() => {
    const status = search.get("integrations");
    const provider = search.get("provider");
    if (!status || !provider) return;
    const label = PROVIDER_CATALOG.find((p) => p.id === provider)?.name ?? provider;
    if (status === "connected") onToast(`${label} connected`, "success");
    else if (status === "cancelled") onToast(`${label} connection cancelled`, "info");
    else if (status === "error") {
      const reason = search.get("reason");
      onToast(
        reason === "INTEGRATION_NOT_CONFIGURED"
          ? `${label} isn't set up on this server yet. Please contact your administrator.`
          : `${label} could not be connected. Please try again.`,
        "error",
      );
    }
    // Drop the one-shot result from the URL so a refresh doesn't repeat the toast.
    const url = new URL(window.location.href);
    url.searchParams.delete("integrations");
    url.searchParams.delete("provider");
    url.searchParams.delete("reason");
    window.history.replaceState(window.history.state, "", url.toString());
    // Reload list so the connected status badge appears.
    load();
  }, [search, load, onToast]);

  async function handleConnect(provider: string) {
    setBusyProvider(provider);
    try {
      const result = await api.post<InitiateAuthResponse>(`/integrations/${provider}/connect`, {});
      if (result.mode === "oauth" && result.authUrl) {
        // Standard OAuth redirect triggered from a click handler
        // (handleConnect), not render/effect code. The rule flags any
        // `window.location.href` reassignment as "modifying a variable
        // defined outside a component" regardless of call-site context;
        // navigating the browser here is the intended, correct side effect.
        // eslint-disable-next-line react-hooks/immutability
        window.location.href = result.authUrl;
        return;
      }
      if (result.mode === "api_key" && result.instructions) {
        setPasteModal({ provider, instructions: result.instructions });
        setBusyProvider(null);
        return;
      }
      throw new Error("Unsupported auth response from server");
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        "Could not start connection.";
      onToast(`Could not start connection: ${msg}`, "error");
      setBusyProvider(null);
    }
  }

  async function handleDisconnectConfirmed(integration: Integration) {
    setConfirmDisconnect(null);
    setBusyProvider(integration.provider);
    try {
      await api.delete(`/integrations/${integration.id}`);
      onToast("Integration disconnected", "success");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Disconnect failed";
      onToast(`Disconnect failed: ${msg}`, "error");
    } finally {
      setBusyProvider(null);
    }
  }

  async function handleSyncNow(integration: Integration) {
    setBusyProvider(integration.provider);
    try {
      await api.post(`/integrations/${integration.id}/sync`, {});
      onToast("Sync started", "success");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      onToast(`Sync failed: ${msg}`, "error");
    } finally {
      setBusyProvider(null);
    }
  }

  // Filter out revoked rows so users see "Not connected" again, and pick
  // the most recent (non-revoked) row per provider.
  const byProvider = new Map<string, Integration>();
  for (const row of integrations) {
    if (row.status === "revoked") continue;
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, row);
  }

  return (
    <section
      id="section-integrations"
      className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
    >
      <div className="px-6 py-5 border-b border-border-subtle flex items-center gap-3">
        <div className="p-2 bg-primary-light rounded-lg text-primary border border-primary/20">
          <span className="material-symbols-outlined text-[20px] block">extension</span>
        </div>
        <div>
          <h2 className="text-base font-bold text-text-main">Integrations</h2>
          <p className="text-xs text-text-muted">
            Connect Granola, Gmail, and Google so meetings, emails, events, Drive files, and NDA Google Docs auto-link to deals and contacts.
          </p>
        </div>
      </div>

      <div className="p-6">
        {/* QA #21: tools without a connector yet — point at the CSV route. */}
        <p className="mb-4 text-xs text-text-muted">
          Using Notion, Airtable, OneDrive, SharePoint or Xero? Export to CSV or Excel and use{" "}
          <span className="font-semibold text-text-main">Deals → Import Deals</span> or{" "}
          <span className="font-semibold text-text-main">Contacts → Import from CSV</span>.{" "}
          <a href="/help-center" className="font-semibold text-primary hover:underline">How to export</a>
        </p>
        {loading ? (
          <p className="text-sm text-text-muted">Loading integrations...</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PROVIDER_CATALOG.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                integration={byProvider.get(p.id) ?? null}
                busy={busyProvider === p.id}
                onConnect={() => handleConnect(p.id)}
                onDisconnect={(i) => setConfirmDisconnect(i)}
                onSyncNow={(i) => handleSyncNow(i)}
              />
            ))}
          </div>
        )}
      </div>

      {pasteModal && (
        <PasteKeyModal
          provider={pasteModal.provider}
          instructions={pasteModal.instructions}
          onClose={() => setPasteModal(null)}
          onConnected={() => {
            const name = PROVIDER_CATALOG.find((p) => p.id === pasteModal.provider)?.name ?? pasteModal.provider;
            setPasteModal(null);
            onToast(`${name} connected`, "success");
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDisconnect}
        title="Disconnect integration?"
        message="Past data stays in your CRM, but no new items will sync. You can reconnect anytime."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => confirmDisconnect && handleDisconnectConfirmed(confirmDisconnect)}
        onCancel={() => setConfirmDisconnect(null)}
      />

      {/* HubSpot CRM import panel */}
      <div className="border-t border-border-subtle">
        <HubSpotPanel onToast={onToast} />
      </div>
    </section>
  );
}

// ─── HubSpot CRM import panel ────────────────────────────────────────

interface HubSpotPanelProps {
  onToast: (message: string, type: "success" | "error" | "info") => void;
}

export function HubSpotPanel({ onToast }: HubSpotPanelProps) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<HubSpotImportJob | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refreshes `job` from the server and stops polling once it reaches a
  // terminal state. Shared by the manual-start flow and the mount-resume
  // flow below so both drive the exact same completion/toast logic.
  const pollJobOnce = useCallback(async (jobId: string) => {
    const j = await api.get<HubSpotImportJob>(`/integrations/hubspot/import/${jobId}`);
    setJob(j);
    if (POLL_TERMINAL.has(j.status) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      if (j.status === "completed") onToast("HubSpot import finished", "success");
      else onToast(`Import ended with status: ${j.status}`, "error");
    }
    return j;
  }, [onToast]);

  const startPolling = useCallback((jobId: string) => {
    if (pollRef.current) return;
    void pollJobOnce(jobId);
    pollRef.current = setInterval(() => {
      pollJobOnce(jobId).catch(console.warn);
    }, 2000);
  }, [pollJobOnce]);

  // Keeps calling /continue until the server says there's nothing left.
  // Used both right after starting a brand-new import and when resuming one
  // found already `running` on mount (reload / new tab).
  const driveContinue = useCallback(async (jobId: string, mode: "fill" | "refresh", initialMore: boolean) => {
    let hasMore = initialMore;
    let rounds = 0;
    while (hasMore && rounds < MAX_CONTINUE_ROUNDS) {
      const next = await api.post<{ more: boolean }>(`/integrations/hubspot/import/${jobId}/continue`, { mode });
      hasMore = next.more;
      rounds += 1;
    }
    return hasMore;
  }, []);

  useEffect(() => {
    api.get<{ connected: boolean }>("/integrations/hubspot/connect")
      .then((r) => setConnected(r.connected))
      .catch(() => {});

    // Re-hydrate the progress card / "last import" summary after a reload —
    // without this, a running job becomes invisible the moment the tab that
    // started it closes or refreshes, even though it's still working
    // server-side (confirmed 2026-10-05: a job kept advancing for hours
    // with zero browser tabs driving it visibly).
    api.get<{ job: HubSpotImportJob | null }>("/integrations/hubspot/import/latest")
      .then(async (r) => {
        if (!r.job) return;
        setJob(r.job);
        if (r.job.status === "running") {
          const mode: "fill" | "refresh" = overwrite ? "refresh" : "fill";
          startPolling(r.job.id);
          const hasMore = await driveContinue(r.job.id, mode, true);
          if (hasMore) {
            setError("Import is taking unusually long. Click \"Import from HubSpot\" again to resume where it left off.");
          }
        }
      })
      .catch(() => {});

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // Intentionally mount-only: `overwrite` reflects the checkbox's default
    // state at load time, not a value this effect should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ connected: boolean }>("/integrations/hubspot/connect", { token });
      setConnected(r.connected);
      setToken("");
      onToast("HubSpot connected", "success");
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        "Failed to connect";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.delete<{ connected: boolean }>("/integrations/hubspot/connect");
      setConnected(false);
      setJob(null);
      onToast("HubSpot disconnected", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Disconnect failed";
      onToast(`Disconnect failed: ${msg}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function startImport() {
    if (pollRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const mode: "fill" | "refresh" = overwrite ? "refresh" : "fill";
      const { jobId, more } = await api.post<{ jobId: string; more: boolean }>(
        "/integrations/hubspot/import",
        { mode },
      );

      startPolling(jobId);

      const hasMore = await driveContinue(jobId, mode, more);
      if (hasMore) {
        // Far beyond any realistic import size — stop rather than hammer the
        // server. The job is still resumable: clicking Import again picks it up.
        setError("Import is taking unusually long. Click \"Import from HubSpot\" again to resume where it left off.");
      }
      // Final refresh so the card reflects the terminal state immediately
      // rather than waiting for the next poll tick.
      await pollJobOnce(jobId).catch(console.warn);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        "Failed to start import";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const isImporting = job?.status === "running";

  return (
    <div className="px-6 py-5">
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: "#FF7A59", color: "#fff" }}
        >
          <span className="material-symbols-outlined text-[20px]">hub</span>
        </div>
        <div>
          <div className="text-sm font-bold text-text-main">HubSpot CRM Import</div>
          <div className="text-xs text-text-muted">
            One-time import of contacts, companies, deals, and activity history (notes, calls, meetings, emails, tasks) from HubSpot.
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-text-secondary mb-1">
              HubSpot Private App token
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && token.length >= 10) connect(); }}
              placeholder="pat-na1-…"
              disabled={busy}
              className="w-full border border-border-subtle rounded-md px-3 py-2 text-sm focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-text-muted">
              HubSpot → Settings → Integrations → Private Apps. Under Scopes, grant{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.companies.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.contacts.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.deals.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.notes.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.calls.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.meetings.read</code>,{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.emails.read</code> and{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.tasks.read</code>, plus the matching{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.schemas.*</code> scopes for companies, contacts and deals (needed to import your custom fields).
            </p>
          </div>
          <button
            type="button"
            onClick={connect}
            disabled={busy || token.length < 10}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {busy ? "Connecting…" : "Connect HubSpot"}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span
              className="inline-flex items-center gap-1.5 text-sm font-semibold px-2 py-0.5 rounded"
              style={{ backgroundColor: "#ECFDF5", color: "#047857" }}
            >
              <span className="text-[10px]">●</span> HubSpot connected
            </span>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="text-xs font-semibold text-text-secondary hover:text-red-600 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={busy || isImporting}
              className="mt-0.5 h-4 w-4 rounded border-border-subtle accent-[#003366] disabled:opacity-50"
            />
            <span className="text-xs">
              <span className="font-semibold text-text-main">
                Overwrite existing values with HubSpot data
              </span>
              <span className="block text-text-muted">
                Off by default: fields already filled in Avise are left untouched. Turn this on to
                re-import after correcting records in HubSpot.
              </span>
            </span>
          </label>

          <button
            type="button"
            onClick={startImport}
            disabled={busy || isImporting}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {isImporting ? "Importing…" : "Import from HubSpot"}
          </button>

          {job && (
            <div className="rounded-lg border border-border-subtle bg-gray-50 p-4 space-y-2">
              {HUBSPOT_OBJECTS.map((obj) => {
                const c = job.objectCounts?.[obj];
                return (
                  <div key={obj} className="flex items-center justify-between text-sm">
                    <span className="capitalize text-text-secondary">{obj}</span>
                    <span className="text-text-main font-medium">
                      {c ? `${c.created + c.updated} imported · ${c.failed} failed` : "—"}
                    </span>
                  </div>
                );
              })}
              <div className="pt-1 text-xs text-text-muted" data-testid="hubspot-job-status">
                Status: <span className="font-semibold">{job.status}</span>
                {job.currentObject ? ` (syncing ${job.currentObject})` : ""}
                {job.error ? ` — ${job.error}` : ""}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PasteKeyModal, type PasteKeyInstructions } from "./IntegrationsSection.PasteKeyModal";

interface ProviderCatalogEntry {
  id: string;
  name: string;
  desc: string;
  icon: string;
  available: boolean;
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "granola",         name: "Granola",         desc: "Auto-import meeting transcripts",        icon: "mic",         available: true },
  { id: "gmail",           name: "Gmail",           desc: "Sync deal-related emails",               icon: "mail",        available: true },
  { id: "google_calendar", name: "Google",           desc: "Drive files, Calendar & NDA docs",       icon: "workspaces",  available: true },
  { id: "outlook",         name: "Outlook",          desc: "Sync deal-related emails",              icon: "mail",        available: true },
  { id: "microsoft365",    name: "Microsoft 365",    desc: "Calendar events + OneDrive files",      icon: "workspaces",  available: true },
  { id: "fireflies",       name: "Fireflies",       desc: "Auto-import meeting transcripts",        icon: "mic",         available: false },
  { id: "otter",           name: "Otter",           desc: "Auto-import meeting transcripts",        icon: "graphic_eq",  available: false },
];

type IntegrationStatus = "connected" | "token_expired" | "error" | "revoked";

interface Integration {
  id: string;
  provider: string;
  status: IntegrationStatus;
  externalAccountEmail?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
}

interface InitiateAuthResponse {
  mode: "oauth" | "api_key";
  authUrl?: string;
  state?: string;
  instructions?: PasteKeyInstructions;
}

const STATUS_BADGE: Record<IntegrationStatus, { bg: string; fg: string; label: string }> = {
  connected:     { bg: "#ECFDF5", fg: "#047857", label: "Connected" },
  token_expired: { bg: "#FFFBEB", fg: "#92400E", label: "Reconnect needed" },
  error:         { bg: "#FEF2F2", fg: "#991B1B", label: "Error" },
  revoked:       { bg: "#F3F4F6", fg: "#374151", label: "Disconnected" },
};

// ─── HubSpot types ──────────────────────────────────────────────────

interface HubSpotJobCounts {
  processed: number;
  created: number;
  updated: number;
  failed: number;
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

// ────────────────────────────────────────────────────────────────────

interface Props {
  onToast: (message: string, type: "success" | "error") => void;
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
    else if (status === "error") onToast(`${label} could not be connected. Please try again.`, "error");
    // Reload list so the connected status badge appears.
    load();
  }, [search, load, onToast]);

  async function handleConnect(provider: string) {
    setBusyProvider(provider);
    try {
      const result = await api.post<InitiateAuthResponse>(`/integrations/${provider}/connect`, {});
      if (result.mode === "oauth" && result.authUrl) {
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
  onToast: (message: string, type: "success" | "error") => void;
}

function HubSpotPanel({ onToast }: HubSpotPanelProps) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<HubSpotImportJob | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.get<{ connected: boolean }>("/integrations/hubspot/connect")
      .then((r) => setConnected(r.connected))
      .catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
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
      const { jobId } = await api.post<{ jobId: string }>("/integrations/hubspot/import", {
        mode: overwrite ? "refresh" : "fill",
      });
      // Immediately fetch initial state, then poll every 2 s
      const fetchJob = async () => {
        const j = await api.get<HubSpotImportJob>(`/integrations/hubspot/import/${jobId}`);
        setJob(j);
        if (POLL_TERMINAL.has(j.status) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (j.status === "completed") onToast("HubSpot import finished", "success");
          else onToast(`Import ended with status: ${j.status}`, "error");
        }
      };
      void fetchJob();
      pollRef.current = setInterval(() => {
        fetchJob().catch(console.warn);
      }, 2000);
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
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.contacts.read</code> and{" "}
              <code className="text-xs bg-gray-100 px-1 rounded">crm.objects.deals.read</code>.
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
                Off by default: fields already filled in PE OS are left untouched. Turn this on to
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
              <div className="pt-1 text-xs text-text-muted">
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

// ─── Provider card ────────────────────────────────────────────────────

interface CardProps {
  provider: ProviderCatalogEntry;
  integration: Integration | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: (i: Integration) => void;
  onSyncNow: (i: Integration) => void;
}

function ProviderCard({ provider, integration, busy, onConnect, onDisconnect, onSyncNow }: CardProps) {
  const isComingSoon = !provider.available;
  const badge = integration ? STATUS_BADGE[integration.status] : null;
  const ctaDisabled = busy || (!integration && isComingSoon);
  const ctaLabel = busy
    ? "Working…"
    : integration
      ? "Disconnect"
      : isComingSoon
        ? "Coming soon"
        : "Connect";
  const ctaStyle: React.CSSProperties = integration
    ? { backgroundColor: "#FEF2F2", color: "#991B1B", border: "1px solid #FCA5A5" }
    : { backgroundColor: "#003366", color: "#fff" };

  return (
    <div className="bg-white border border-border-subtle rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: "#E6EEF5", color: "#003366" }}
          >
            <span className="material-symbols-outlined">{provider.icon}</span>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-main truncate">{provider.name}</div>
            <div className="text-xs text-text-muted truncate">{provider.desc}</div>
          </div>
        </div>
        {badge ? (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold shrink-0"
            style={{ backgroundColor: badge.bg, color: badge.fg }}
          >
            {badge.label}
          </span>
        ) : (
          <span className="text-xs text-text-muted shrink-0">Not connected</span>
        )}
      </div>

      {integration?.externalAccountEmail && (
        <div className="text-xs text-text-muted truncate">
          Connected as {integration.externalAccountEmail}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 mt-1">
        <div className="text-xs text-text-muted truncate">
          {integration?.lastSyncAt
            ? `Last sync: ${new Date(integration.lastSyncAt).toLocaleString()}`
            : ""}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {integration && (
            <button
              type="button"
              onClick={() => onSyncNow(integration)}
              disabled={busy}
              className="text-xs font-semibold rounded-md px-3 py-1.5 border border-border-subtle bg-white text-text-secondary hover:bg-gray-50 disabled:opacity-50"
            >
              Sync now
            </button>
          )}
          <button
            type="button"
            onClick={() => (integration ? onDisconnect(integration) : onConnect())}
            disabled={ctaDisabled}
            className={`text-xs font-semibold rounded-md px-3 py-1.5 transition-opacity ${
              ctaDisabled ? "opacity-50 cursor-not-allowed" : "hover:opacity-90"
            }`}
            style={ctaStyle}
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

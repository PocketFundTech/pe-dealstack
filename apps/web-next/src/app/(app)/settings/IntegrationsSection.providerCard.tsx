"use client";

// Provider card for Settings → Integrations (split out of IntegrationsSection
// to keep that file under the size limit).

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  desc: string;
  icon: string;
  available: boolean;
}

export type IntegrationStatus = "connected" | "token_expired" | "error" | "revoked";

export interface Integration {
  id: string;
  provider: string;
  status: IntegrationStatus;
  externalAccountEmail?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
}

const STATUS_BADGE: Record<IntegrationStatus, { bg: string; fg: string; label: string }> = {
  connected:     { bg: "#ECFDF5", fg: "#047857", label: "Connected" },
  token_expired: { bg: "#FFFBEB", fg: "#92400E", label: "Reconnect needed" },
  error:         { bg: "#FEF2F2", fg: "#991B1B", label: "Error" },
  revoked:       { bg: "#F3F4F6", fg: "#374151", label: "Disconnected" },
};

// ─── Provider card ────────────────────────────────────────────────────

interface CardProps {
  provider: ProviderCatalogEntry;
  integration: Integration | null;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: (i: Integration) => void;
  onSyncNow: (i: Integration) => void;
}

export function ProviderCard({ provider, integration, busy, onConnect, onDisconnect, onSyncNow }: CardProps) {
  const isComingSoon = !provider.available;
  const badge = integration ? STATUS_BADGE[integration.status] : null;
  // An expired or failing connection can't sync; the way forward is to
  // reconnect (the OAuth callback updates the existing integration row).
  const needsReconnect = integration?.status === "token_expired" || integration?.status === "error";
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
        <div className="flex flex-1 items-center gap-3 min-w-0">
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

      {needsReconnect && integration?.lastSyncError && (
        <div className="text-xs rounded-md px-2 py-1.5" style={{ backgroundColor: "#FEF2F2", color: "#991B1B" }}>
          {integration.lastSyncError}
        </div>
      )}

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
          {integration && !needsReconnect && (
            <button
              type="button"
              onClick={() => onSyncNow(integration)}
              disabled={busy}
              className="text-xs font-semibold rounded-md px-3 py-1.5 border border-border-subtle bg-white text-text-secondary hover:bg-gray-50 disabled:opacity-50"
            >
              Sync now
            </button>
          )}
          {needsReconnect && (
            <button
              type="button"
              onClick={onConnect}
              disabled={busy}
              className="text-xs font-semibold rounded-md px-3 py-1.5 text-white hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: "#003366" }}
            >
              Reconnect
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

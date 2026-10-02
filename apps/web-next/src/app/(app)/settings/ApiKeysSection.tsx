"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface Props {
  onToast: (message: string, type: "success" | "error" | "info") => void;
}

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
}

function keyStatus(k: ApiKey): { label: string; className: string } {
  if (k.revokedAt) return { label: "Revoked", className: "bg-gray-100 text-text-secondary" };
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now())
    return { label: "Expired", className: "bg-amber-50 text-amber-700" };
  return { label: "Active", className: "bg-emerald-50 text-emerald-700" };
}

export function ApiKeysSection({ onToast }: Props) {
  const { user } = useUser();
  const isAdmin = user?.systemRole?.toUpperCase() === "ADMIN";

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ apiKeys: ApiKey[] }>("/api-keys");
      setKeys(res.apiKeys);
      setLoadError(null);
    } catch (err) {
      console.warn("[ApiKeysSection] failed to load /api-keys:", err);
      setLoadError(
        "Couldn't load API keys. If this is a new deployment, the ApiKey database migration (apps/api/api-keys-migration.sql) may not have been run yet.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
    else setLoading(false);
  }, [isAdmin, load]);

  async function createKey() {
    if (!name.trim()) {
      onToast('Give the key a name first, e.g. "n8n — deal intake"', "error");
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<{ apiKey: ApiKey; key: string }>("/api-keys", {
        name: name.trim(),
        expiresInDays: expiryDays,
      });
      setNewKey(res.key);
      setKeys((prev) => [res.apiKey, ...prev]);
      setName("");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't create the API key. Please try again.", "error");
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(k: ApiKey) {
    if (!window.confirm(`Revoke "${k.name}"? Anything using this key (n8n workflows, scripts) will stop working immediately.`))
      return;
    try {
      await api.delete(`/api-keys/${k.id}`);
      setKeys((prev) => prev.map((x) => (x.id === k.id ? { ...x, revokedAt: new Date().toISOString() } : x)));
      onToast(`"${k.name}" revoked`, "success");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't revoke the key. Please try again.", "error");
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label} copied`, "success");
    } catch {
      onToast("Couldn't copy automatically — select the key and copy it manually.", "error");
    }
  }

  return (
    <section
      id="section-api-keys"
      className="bg-white rounded-xl border border-border-subtle shadow-sm overflow-hidden"
    >
      <div className="p-6 border-b border-border-subtle">
        <h3 className="text-lg font-bold text-text-main">API Keys</h3>
        <p className="text-sm text-text-secondary mt-1">
          Connect n8n, Zapier, Make or your own scripts to Avise. The API key <strong>is</strong> your Bearer token:
          send it as{" "}
          <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">Authorization: Bearer avise_sk_…</code>{" "}
          to any <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">https://app.avise.io/api/…</code> endpoint.
          A key acts as you, inside your organization.{" "}
          <a href="/api-reference" target="_blank" rel="noreferrer" className="text-[#003366] font-medium hover:underline">
            API reference
          </a>
        </p>
      </div>

      <div className="p-6 space-y-6">
        {!isAdmin ? (
          <p className="text-sm text-text-secondary">
            Only organization admins can create API keys. Ask an admin on your team to create one for your integration.
          </p>
        ) : (
          <>
            {newKey && (
              <div className="rounded-lg border border-[#003366]/20 bg-[#003366]/5 p-4">
                <p className="text-sm font-semibold text-text-main">Copy your new key now — you won&apos;t see it again.</p>
                {[
                  { label: "API key", value: newKey },
                  { label: "Authorization header", value: `Authorization: Bearer ${newKey}` },
                ].map((row) => (
                  <div key={row.label} className="mt-3">
                    <span className="block text-xs text-text-secondary mb-1">{row.label}</span>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 break-all rounded bg-white border border-border-subtle px-3 py-2 text-xs font-mono">
                        {row.value}
                      </code>
                      <button
                        type="button"
                        onClick={() => copyText(row.value, row.label)}
                        className="shrink-0 rounded-lg bg-[#003366] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
                <p className="mt-3 text-xs text-text-secondary">
                  In n8n: Credentials → Header Auth, Name <code>Authorization</code>, Value <code>Bearer &lt;key&gt;</code>.
                </p>
                <button
                  type="button"
                  onClick={() => setNewKey(null)}
                  className="mt-3 text-xs text-text-secondary hover:text-text-main"
                >
                  I&apos;ve stored it safely — hide
                </button>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex-1 text-sm">
                <span className="block text-text-secondary mb-1">Key name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="n8n — deal intake"
                  className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#003366]/30"
                />
              </label>
              <label className="text-sm">
                <span className="block text-text-secondary mb-1">Expires</span>
                <select
                  value={expiryDays ?? ""}
                  onChange={(e) => setExpiryDays(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-border-subtle px-3 py-2 text-sm bg-white"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.label} value={o.days ?? ""}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={createKey}
                disabled={creating}
                className="rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create key"}
              </button>
            </div>

            {loading ? (
              <div className="text-text-secondary py-2 text-sm">Loading…</div>
            ) : loadError ? (
              <p className="text-sm text-red-700">{loadError}</p>
            ) : keys.length === 0 ? (
              <p className="text-sm text-text-secondary italic">
                No API keys yet. Create one above to connect n8n or another tool.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-text-secondary border-b border-border-subtle">
                    <th className="py-2">Name</th>
                    <th className="py-2">Key</th>
                    <th className="py-2">Last used</th>
                    <th className="py-2">Expires</th>
                    <th className="py-2">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const status = keyStatus(k);
                    return (
                      <tr key={k.id} className="border-b border-border-subtle/40">
                        <td className="py-2 font-medium text-text-main">{k.name}</td>
                        <td className="py-2 font-mono text-xs text-text-secondary">
                          {k.keyPrefix}…{k.lastFour}
                        </td>
                        <td className="py-2 text-text-secondary">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never used"}</td>
                        <td className="py-2 text-text-secondary">{k.expiresAt ? formatDate(k.expiresAt) : "Never"}</td>
                        <td className="py-2">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
                            {status.label}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          {!k.revokedAt && (
                            <button
                              type="button"
                              onClick={() => revokeKey(k)}
                              className="text-xs font-medium text-red-700 hover:underline"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </section>
  );
}

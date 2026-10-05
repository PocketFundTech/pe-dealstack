"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

interface Webhook {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  failureCount: number;
}

interface Props {
  onToast: (message: string, type: "success" | "error" | "info") => void;
}

// Mirrors WEBHOOK_EVENTS in apps/api/src/services/outboundWebhooks.ts.
const EVENT_GROUPS: { label: string; events: string[] }[] = [
  { label: "Deals", events: ["deal.created", "deal.updated", "deal.stage_changed", "deal.deleted"] },
  { label: "Contacts", events: ["contact.created", "contact.updated", "contact.deleted"] },
  { label: "Tasks", events: ["task.created", "task.updated", "task.completed"] },
  { label: "Documents", events: ["document.uploaded"] },
];

function deliveryStatus(w: Webhook): { label: string; className: string } {
  if (!w.active) return { label: "Paused", className: "bg-gray-100 text-text-secondary" };
  if (!w.lastDeliveryAt) return { label: "No deliveries yet", className: "bg-gray-100 text-text-secondary" };
  if (w.failureCount > 0) return { label: `Failing (${w.failureCount})`, className: "bg-red-50 text-red-700" };
  return { label: "Delivering", className: "bg-emerald-50 text-emerald-700" };
}

export function WebhooksSection({ onToast }: Props) {
  const { user } = useUser();
  const isAdmin = user?.systemRole?.toUpperCase() === "ADMIN";

  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["deal.created", "deal.stage_changed"]);
  const [saving, setSaving] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ webhooks: Webhook[] }>("/webhook-subscriptions");
      setHooks(res.webhooks);
      setLoadError(null);
    } catch (err) {
      console.warn("[WebhooksSection] failed to load /webhook-subscriptions:", err);
      setLoadError(
        "Couldn't load webhooks. If this is a new deployment, the WebhookSubscription database migration (apps/api/webhook-subscriptions-migration.sql) may not have been run yet.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
    else setLoading(false);
  }, [isAdmin, load]);

  function toggleEvent(event: string) {
    setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  async function addWebhook() {
    if (!url.trim().startsWith("https://")) {
      onToast("Enter the full https:// URL from your n8n Webhook node (or Zapier / Make).", "error");
      return;
    }
    if (events.length === 0) {
      onToast("Pick at least one event to send.", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ webhook: Webhook; secret: string }>("/webhook-subscriptions", {
        url: url.trim(),
        events,
      });
      setHooks((prev) => [res.webhook, ...prev]);
      setNewSecret(res.secret);
      setUrl("");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't add the webhook. Please try again.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest(w: Webhook) {
    setBusyId(w.id);
    try {
      const res = await api.post<{ ok: boolean; status: number; error?: string }>(`/webhook-subscriptions/${w.id}/test`, {});
      if (res.ok) onToast(`Test delivered — your endpoint answered ${res.status}.`, "success");
      else onToast(`Test failed: ${res.error ?? `HTTP ${res.status}`}. Check the URL is live and returns 2xx.`, "error");
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't send the test. Please try again.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function setActive(w: Webhook, active: boolean) {
    setBusyId(w.id);
    try {
      const res = await api.patch<{ webhook: Webhook }>(`/webhook-subscriptions/${w.id}`, { active });
      setHooks((prev) => prev.map((x) => (x.id === w.id ? res.webhook : x)));
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't update the webhook.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(w: Webhook) {
    if (!window.confirm(`Delete the webhook to ${w.url}? Avise will stop sending events there immediately.`)) return;
    setBusyId(w.id);
    try {
      await api.delete(`/webhook-subscriptions/${w.id}`);
      setHooks((prev) => prev.filter((x) => x.id !== w.id));
      onToast("Webhook deleted", "success");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't delete the webhook.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function copySecret() {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      onToast("Signing secret copied", "success");
    } catch {
      onToast("Couldn't copy automatically — select the secret and copy it manually.", "error");
    }
  }

  return (
    <section
      id="section-webhooks"
      className="bg-white rounded-xl border border-border-subtle shadow-sm overflow-hidden"
    >
      <div className="p-6 border-b border-border-subtle">
        <h3 className="text-lg font-bold text-text-main">Webhooks</h3>
        <p className="text-sm text-text-secondary mt-1">
          Avise sends events (a new deal, a stage change, an uploaded document…) to a URL you choose, so n8n, Zapier
          or Make can react instantly instead of polling. Each delivery is signed with the secret shown when you add
          the webhook.
        </p>
      </div>

      <div className="p-6 space-y-6">
        {!isAdmin ? (
          <p className="text-sm text-text-secondary">
            Only organization admins can manage webhooks. Ask an admin on your team to add one.
          </p>
        ) : (
          <>
            {newSecret && (
              <div className="rounded-lg border border-[#003366]/20 bg-[#003366]/5 p-4">
                <p className="text-sm font-semibold text-text-main">
                  Signing secret — copy it now, you won&apos;t see it again.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 break-all rounded bg-white border border-border-subtle px-3 py-2 text-xs font-mono">
                    {newSecret}
                  </code>
                  <button
                    type="button"
                    onClick={copySecret}
                    className="shrink-0 rounded-lg bg-[#003366] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
                  >
                    Copy
                  </button>
                </div>
                <p className="mt-2 text-xs text-text-secondary">
                  Optional: verify the <code>Avise-Signature</code> header with it. Details in the API reference.
                </p>
                <button
                  type="button"
                  onClick={() => setNewSecret(null)}
                  className="mt-3 text-xs text-text-secondary hover:text-text-main"
                >
                  I&apos;ve stored it — hide
                </button>
              </div>
            )}

            <div className="space-y-4">
              <label className="block text-sm">
                <span className="block text-text-secondary mb-1">Endpoint URL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-n8n.example.com/webhook/avise-deals"
                  className="w-full rounded-lg border border-border-subtle px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#003366]/30"
                />
              </label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {EVENT_GROUPS.map((group) => (
                  <fieldset key={group.label} className="text-sm">
                    <legend className="text-text-secondary mb-1">{group.label}</legend>
                    {group.events.map((ev) => (
                      <label key={ev} className="flex items-center gap-2 py-0.5">
                        <input
                          type="checkbox"
                          checked={events.includes(ev)}
                          onChange={() => toggleEvent(ev)}
                          className="accent-[#003366]"
                        />
                        <code className="text-xs">{ev}</code>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
              <button
                type="button"
                onClick={addWebhook}
                disabled={saving}
                className="rounded-lg bg-[#003366] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Adding…" : "Add webhook"}
              </button>
            </div>

            {loading ? (
              <div className="text-text-secondary py-2 text-sm">Loading…</div>
            ) : loadError ? (
              <p className="text-sm text-red-700">{loadError}</p>
            ) : hooks.length === 0 ? (
              <p className="text-sm text-text-secondary italic">
                No webhooks yet. Paste the URL of an n8n Webhook node above to get events as they happen.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle border-t border-border-subtle">
                {hooks.map((w) => {
                  const status = deliveryStatus(w);
                  return (
                    <li key={w.id} className="py-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-text-main break-all">{w.url}</p>
                        <p className="mt-1 text-xs text-text-secondary">{w.events.join(" · ")}</p>
                        {w.lastError && w.failureCount > 0 && (
                          <p className="mt-1 text-xs text-red-700">Last attempt: {w.lastError}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
                          {status.label}
                        </span>
                        <button
                          type="button"
                          disabled={busyId === w.id}
                          onClick={() => sendTest(w)}
                          className="text-xs font-medium text-[#003366] hover:underline disabled:opacity-50"
                        >
                          Send test
                        </button>
                        <button
                          type="button"
                          disabled={busyId === w.id}
                          onClick={() => setActive(w, !w.active)}
                          className="text-xs font-medium text-text-secondary hover:underline disabled:opacity-50"
                        >
                          {w.active ? "Pause" : "Resume"}
                        </button>
                        <button
                          type="button"
                          disabled={busyId === w.id}
                          onClick={() => remove(w)}
                          className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

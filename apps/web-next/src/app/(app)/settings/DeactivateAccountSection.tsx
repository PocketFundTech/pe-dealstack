"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";

// QA #16: the user deactivates their own account (POST /api/users/me/deactivate).
// Soft: the firm keeps their deals, notes and documents, and an admin can
// reactivate them. Their API keys and connected integrations stop working and
// every session is signed out. The firm's last admin is refused (409).

const CONFIRM_WORD = "DEACTIVATE";

export function DeactivateAccountSection() {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deactivate = async () => {
    if (typed !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/users/me/deactivate", { confirm: CONFIRM_WORD });
      // The server already ended every session; this clears the local one.
      await signOut().catch(() => { window.location.href = "/login"; });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not deactivate your account.");
      setBusy(false);
    }
  };

  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-red-700">Deactivate your account</h4>
          <p className="text-xs text-red-600/80">
            You&apos;ll be signed out everywhere and can&apos;t sign back in. Your deals, notes and documents stay with
            your firm. Your API keys and connected integrations stop working. An admin can reactivate you.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 px-4 py-2 bg-white border border-red-200 text-red-600 text-xs font-bold rounded-lg hover:bg-red-50 transition-colors shadow-sm"
          >
            Deactivate
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="deactivate-confirm" className="text-xs text-red-700">
            Type <strong>{CONFIRM_WORD}</strong> to confirm
          </label>
          <input
            id="deactivate-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="rounded border border-red-200 bg-white px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={deactivate}
            disabled={typed !== CONFIRM_WORD || busy}
            className="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg disabled:opacity-50"
          >
            {busy ? "Deactivating…" : "Deactivate my account"}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setTyped(""); setError(null); }}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-text-secondary"
          >
            Cancel
          </button>
          {error && <p className="basis-full text-xs text-red-700">{error}</p>}
        </div>
      )}
    </div>
  );
}

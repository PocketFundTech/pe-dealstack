"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { DealPicker, type PickableDeal } from "./DealPicker";
import {
  ChooseFromDriveButton,
  PickedDocChip,
} from "./ImportGoogleDocControls";
import {
  getGooglePickerConfig,
  pickGoogleDoc,
  preloadGooglePicker,
  type PickedGoogleDoc,
} from "./googlePicker";
import type { LegalDocument } from "./types";

interface ImportGoogleDocFlowProps {
  /**
   * Pre-resolved deal context. When provided we skip the deal picker step and
   * go straight to the import form. Mirrors UploadExistingFlow.initialDeal —
   * the page.tsx state machine can pass this through from a deal-scoped entry
   * point later. v1 always starts at pickDeal.
   */
  initialDeal?: PickableDeal;
  onCancel: () => void;
  onImported: (doc: LegalDocument) => void;
}

type Step =
  | { kind: "pickDeal" }
  | { kind: "form"; deal: PickableDeal };

// Body for POST /deals/:dealId/legal-documents/import-gdoc. We send the Drive
// `fileId` returned by the Picker (NOT a URL — the user's own Docs 404 over the
// drive.file scope when addressed by URL; the Picker grant is per-file by id).
// All other fields are optional overrides; the server reads the Doc's real
// title from Drive when `title` is omitted.
interface ImportGdocBody {
  fileId: string;
  title?: string;
  counterpartyName?: string;
  counterpartyEmail?: string;
}

// Response from GET /api/auth/workspace-email — same contract SendModal uses.
// `connected: false` is always a 200 (email: null) when the user hasn't
// connected Google Workspace or we couldn't read their profile.
interface WorkspaceEmailResponse {
  email: string | null;
  connected: boolean;
  // True only for managed Workspace accounts (OAuth `hd` claim). Importing a
  // Doc for the native Google Docs eSignature flow requires Workspace.
  isWorkspace?: boolean;
  error?: "not_connected" | "profile_fetch_failed" | "user_not_provisioned";
}

/**
 * Two-step "bring your own Google Doc" flow. The user picks a Doc they already
 * prepared in their own Drive (where they can add a Google-native eSignature
 * field — something Google offers no API for) via the Google Picker; we import
 * a reference to it as a LegalDocument row (content stays null, the Doc stays
 * the source of truth) and hand it back so the page can drop into
 * GoogleDocImportView.
 *
 * Steps:
 *   1) pickDeal — DealPicker modal (skipped if initialDeal supplied)
 *   2) form     — "Choose from Google Drive" button opens the Picker; once a
 *                 Doc is chosen, optional title/counterparty fields + Import.
 *
 * The Picker (not a pasted URL) is required because the connected OAuth scope
 * is per-file `drive.file`: the server can only fetch Docs the user explicitly
 * granted, which the Picker selection does. See googlePicker.ts for the why.
 */
export function ImportGoogleDocFlow({
  initialDeal,
  onCancel,
  onImported,
}: ImportGoogleDocFlowProps) {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>(
    initialDeal ? { kind: "form", deal: initialDeal } : { kind: "pickDeal" },
  );

  function handleDealSelect(deal: PickableDeal) {
    setStep({ kind: "form", deal });
  }

  if (step.kind === "pickDeal") {
    return <DealPicker open onCancel={onCancel} onSelect={handleDealSelect} />;
  }

  // step.kind === "form"
  return (
    <ImportGdocForm
      deal={step.deal}
      onBack={
        // Only offer "back to deal picker" when the user actually came through
        // it (no pre-resolved deal). With an initialDeal there's nowhere back.
        initialDeal ? undefined : () => setStep({ kind: "pickDeal" })
      }
      onCancel={onCancel}
      onImported={onImported}
      showToast={showToast}
    />
  );
}

interface ImportGdocFormProps {
  deal: PickableDeal;
  onBack?: () => void;
  onCancel: () => void;
  onImported: (doc: LegalDocument) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
}

function ImportGdocForm({
  deal,
  onBack,
  onCancel,
  onImported,
  showToast,
}: ImportGdocFormProps) {
  const pickerConfig = getGooglePickerConfig();
  const [picked, setPicked] = useState<PickedGoogleDoc | null>(null);
  const [title, setTitle] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyEmail, setCounterpartyEmail] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the connected-account check says Google isn't linked, so we can
  // render an inline CTA to Settings instead of opening the picker.
  const [notConnected, setNotConnected] = useState(false);
  // Connected-account lookup, resolved on mount (NOT on click). Keeping the
  // network call out of the click handler is what lets the Picker popup open
  // within the user gesture — an await between click and requestAccessToken
  // gets the popup blocked. `connected: null` = still loading / unknown.
  const [wsConnected, setWsConnected] = useState<boolean | null>(null);
  const [wsEmail, setWsEmail] = useState<string | undefined>(undefined);
  // True only for managed Workspace accounts. The Google Docs eSignature flow
  // an imported Doc feeds into is Workspace-only, so personal accounts can't
  // import — the button is greyed with a tooltip.
  const [wsIsWorkspace, setWsIsWorkspace] = useState<boolean>(false);

  const busy = picking || submitting;
  // Connected to Google but NOT a Workspace account → import is unavailable.
  const requiresWorkspace = wsConnected === true && !wsIsWorkspace;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  // On mount: warm the Google SDK scripts and resolve the connected account so
  // the click handler can open the popup synchronously (no awaits before
  // requestAccessToken → no popup-blocked false positives).
  useEffect(() => {
    preloadGooglePicker();
    let cancelled = false;
    api
      .get<WorkspaceEmailResponse>("/auth/workspace-email")
      .then((ws) => {
        if (cancelled) return;
        setWsConnected(ws.connected);
        setWsEmail(ws.email ?? undefined);
        setWsIsWorkspace(Boolean(ws.isWorkspace));
      })
      .catch((err) => {
        if (cancelled) return;
        // Leave connection state unknown rather than blocking — the pick can
        // still proceed (the account chooser lets the user pick the right
        // one), and the server import surfaces a real error if truly missing.
        console.warn("[nda] workspace-email lookup failed", err);
        setWsConnected(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opens the Picker. The connected-account check + email hint were resolved on
  // mount (see the effect above), so this handler has NO awaits before
  // pickGoogleDoc — the popup opens inside the user gesture. The hint passes the
  // server-connected account email so the chooser pre-selects the right Google
  // account (the browser may be signed into a different one).
  async function handleChoose() {
    if (busy || !pickerConfig.isConfigured) return;
    setError(null);
    setNotConnected(false);
    // Only hard-block when we KNOW Google isn't connected. While the lookup is
    // still loading (null), let the pick proceed — the chooser handles account
    // selection and the server import reports a real error if needed.
    if (wsConnected === false) {
      setNotConnected(true);
      const msg =
        "Connect Google in Settings → Integrations before importing a Doc.";
      setError(msg);
      showToast(msg, "error", { title: "Google not connected" });
      return;
    }
    // Importing a Doc for the native Google Docs eSignature flow is
    // Workspace-only — a personal account has no eSignature panel to add the
    // signer field with. Block early with an actionable message.
    if (requiresWorkspace) {
      const msg =
        "Importing a Google Doc for signature requires a Google Workspace account.";
      setError(msg);
      showToast(msg, "error", { title: "Workspace required" });
      return;
    }
    setPicking(true);
    try {
      const doc = await pickGoogleDoc({ hint: wsEmail });
      if (!doc) return; // user cancelled the picker — no-op
      setPicked(doc);
      // Prefill the title from the Doc's name (still editable) only if the
      // user hasn't already typed one.
      setTitle((prev) => (prev.trim() ? prev : doc.name));
    } catch (err) {
      console.warn("[nda] google picker failed:", err);
      const msg =
        err instanceof Error ? err.message : "Couldn't open Google Drive.";
      setError(msg);
      showToast(msg, "error", { title: "Google Drive picker" });
    } finally {
      setPicking(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!picked) {
      setError("Choose a Google Doc from your Drive first.");
      return;
    }

    const body: ImportGdocBody = {
      fileId: picked.fileId,
      title: title.trim() || undefined,
      counterpartyName: counterpartyName.trim() || undefined,
      counterpartyEmail: counterpartyEmail.trim() || undefined,
    };

    setSubmitting(true);
    setError(null);
    try {
      const doc = await api.post<LegalDocument>(
        `/deals/${deal.id}/legal-documents/import-gdoc`,
        body,
      );
      onImported(doc);
    } catch (err) {
      console.warn("[nda] import-gdoc failed:", err);
      const message = importErrorMessage(err);
      setError(message);
      showToast(message, "error", { title: "Couldn't import Google Doc" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-md p-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onCancel()}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900">
              Import from Google Docs
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">
              For{" "}
              <span className="text-[#003366] font-medium">{deal.label}</span>
              {" · "}Bring a Doc you prepared in your own Drive — add an
              eSignature field there, then send it from here.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="p-1 rounded text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {error && (
            <div className="rounded-lg px-3 py-3 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5 shrink-0">
                error
              </span>
              <div className="flex-1 min-w-0 leading-snug">
                {error}
                {notConnected && (
                  <div className="mt-2">
                    <Link
                      href="/settings#section-integrations"
                      className="text-xs font-semibold rounded-md px-3 py-1.5 text-white hover:opacity-90 inline-flex items-center gap-1"
                      style={{ backgroundColor: "#003366" }}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        settings
                      </span>
                      Open Settings
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Doc chooser — replaces the old URL paste input. */}
          <Field label="Google Doc" required>
            {picked ? (
              <PickedDocChip
                name={picked.name}
                disabled={busy}
                onChange={handleChoose}
              />
            ) : (
              <ChooseFromDriveButton
                configured={pickerConfig.isConfigured}
                picking={picking}
                disabled={busy || requiresWorkspace}
                onClick={handleChoose}
              />
            )}
            {requiresWorkspace ? (
              <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 leading-snug">
                Importing a Google Doc for signature requires a Google
                Workspace account — Google Docs eSignature isn&rsquo;t
                available on personal Google accounts. You can still compose,
                send, and download NDAs.
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] text-slate-500">
                Pick a Doc from the Google account you connected in Settings
                &rarr; Integrations. Choosing it here grants this app access to
                that one file.
              </p>
            )}
          </Field>

          {/* The rest of the form only matters once a Doc is chosen. We keep it
              mounted but disabled so the layout doesn't jump. */}
          <fieldset
            disabled={!picked || busy}
            className={cn(
              "space-y-4 transition-opacity",
              picked ? "opacity-100" : "opacity-50",
            )}
          >
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Leave blank to use the Doc's own title"
                className={inputCls}
              />
            </Field>

            <Field label="Counterparty name">
              <input
                value={counterpartyName}
                onChange={(e) => setCounterpartyName(e.target.value)}
                placeholder="Acme Corp"
                className={inputCls}
              />
            </Field>

            <Field label="Counterparty email">
              <input
                type="email"
                value={counterpartyEmail}
                onChange={(e) => setCounterpartyEmail(e.target.value)}
                placeholder="legal@acme.com"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Pre-fills the recipient when you send the Doc. You can change it
                at send time.
              </p>
            </Field>
          </fieldset>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-2 shrink-0">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              disabled={busy}
              className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">
                arrow_back
              </span>
              Back
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !picked}
              className={cn(
                "px-4 py-2 rounded-md text-sm font-semibold text-white inline-flex items-center gap-1.5",
                busy || !picked
                  ? "opacity-70 cursor-not-allowed"
                  : "hover:opacity-90",
              )}
              style={{ backgroundColor: "#003366" }}
            >
              {submitting && (
                <span className="material-symbols-outlined text-[16px] animate-spin">
                  progress_activity
                </span>
              )}
              {submitting ? "Importing…" : "Import Doc"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// Maps the backend's typed error codes (see the import-gdoc contract) to
// actionable copy. Falls back to the server's own `error` message for unknown
// codes, then to a generic string for non-API errors.
function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "INVALID_GDOC_URL":
        return "We couldn't read a Google Doc id from that selection. Try choosing the Doc again.";
      case "GOOGLE_NOT_CONNECTED":
        return "Google isn't connected yet. Connect it in Settings → Integrations, then try again.";
      case "GOOGLE_SCOPES_MISSING":
        return "Google is connected but needs a re-authorize to read your Docs. Reconnect in Settings → Integrations.";
      case "GDOC_NOT_ACCESSIBLE":
        return `${err.message} Make sure the doc lives in the Google account you connected (Settings → Integrations).`;
      case "DRIVE_API_ERROR":
        return `Google Drive error: ${err.message}`;
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "Failed to import Google Doc";
}

const inputCls =
  "w-full px-3 py-2 text-sm rounded-md border border-slate-200 focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15 outline-none";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-700 mb-1.5">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </div>
      {children}
    </label>
  );
}

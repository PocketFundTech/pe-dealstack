"use client";

// SendModal's "who's actually sending" UI bits — extracted so the parent
// stays under the 500-line cap. Two pieces:
//
//   - SendingFromPill: visually-distinct chip at the top of the modal
//     showing the connected Workspace Gmail address (or a warning when
//     the OAuth token isn't there). Loud on purpose.
//   - SenderLine:      muted "From: …" line under the To field; same
//     source of truth, mirrored copy in a smaller form factor.
//
// Both read the same `WorkspaceEmailState` discriminated union the
// parent populates from /api/auth/workspace-email on modal open.

export type WorkspaceEmailState =
  | { kind: "loading" }
  | { kind: "connected"; email: string }
  | { kind: "notConnected" }
  | { kind: "error" };

/**
 * Muted "From: <gmail>" line under the To field. Three branches:
 *   - loading:      subtle "checking your Workspace connection…"
 *   - connected:    "From: <email> (sent via your Google Workspace Gmail)"
 *   - notConnected: amber inline warning + Settings link
 *
 * `error` (network failure) collapses into the notConnected render — the
 * fetch already logs to console; show actionable copy instead of a
 * "couldn't reach server" message the user can't fix.
 */
export function SenderLine({ state }: { state: WorkspaceEmailState }) {
  if (state.kind === "loading") {
    return (
      <div className="flex items-start gap-1.5 -mt-1 text-xs text-slate-400 leading-snug italic">
        <span className="material-symbols-outlined text-[14px] mt-0.5 text-slate-300 animate-pulse">
          outgoing_mail
        </span>
        <div className="min-w-0">
          From: checking your Google connection…
        </div>
      </div>
    );
  }

  if (state.kind === "connected") {
    return (
      <div className="flex items-start gap-1.5 -mt-1 text-xs text-slate-500 leading-snug">
        <span className="material-symbols-outlined text-[14px] mt-0.5 text-slate-400">
          outgoing_mail
        </span>
        <div className="min-w-0">
          From:{" "}
          <span className="font-medium text-slate-700">{state.email}</span>{" "}
          <span className="text-slate-400">
            (sent via your connected Google account)
          </span>
        </div>
      </div>
    );
  }

  // notConnected | error → actionable warning
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
      <span className="material-symbols-outlined text-[16px] mt-0.5 shrink-0">
        warning
      </span>
      <div className="flex-1 min-w-0 leading-snug">
        Google not connected — sends will fail.{" "}
        <a
          href="/settings#section-integrations"
          className="font-semibold underline hover:no-underline"
        >
          Connect in Settings
        </a>
        .
      </div>
    </div>
  );
}

/**
 * Visually-distinct "Sending from" pill rendered between the header and
 * body. Same source of truth as SenderLine — duplicated on purpose so
 * the user can't miss WHICH Gmail will appear in the recipient's From
 * field. Connected → neutral grey pill (info, not action). Not-connected
 * mirrors SenderLine's amber warning so the user spots it before filling
 * in the form.
 */
export function SendingFromPill({ state }: { state: WorkspaceEmailState }) {
  if (state.kind === "loading") {
    return (
      <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100 shrink-0">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 italic">
          <span className="material-symbols-outlined text-[14px] animate-pulse">
            sync
          </span>
          Resolving your Google sender…
        </div>
      </div>
    );
  }
  if (state.kind === "connected") {
    return (
      <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100 shrink-0">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-slate-200 text-[11px] text-slate-700">
          <span
            className="material-symbols-outlined text-[14px]"
            style={{ color: "#003366" }}
          >
            send
          </span>
          <span className="text-slate-500">Sending from</span>
          <span className="font-semibold text-slate-900">{state.email}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 shrink-0">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-amber-300 text-[11px] text-amber-800">
        <span className="material-symbols-outlined text-[14px]">
          warning
        </span>
        <span className="font-semibold">Google not connected</span>
      </div>
    </div>
  );
}

"use client";

import { roleLabel } from "@/lib/roles";

export type InvitationStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

export interface Invitation {
  id: string;
  email: string;
  role: string;
  status: InvitationStatus;
  inviteUrl?: string | null;
  createdAt: string;
  expiresAt?: string | null;
}

const STATUS_STYLES: Record<InvitationStatus, string> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  ACCEPTED: "bg-green-50 text-green-700 border-green-200",
  EXPIRED: "bg-gray-50 text-gray-600 border-gray-200",
  REVOKED: "bg-gray-50 text-gray-500 border-gray-200",
};

const STATUS_LABELS: Record<InvitationStatus, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

/** A PENDING invite past its expiresAt is EXPIRED, whatever the row says. */
export function effectiveStatus(inv: Invitation, now = Date.now()): InvitationStatus {
  if (inv.status === "PENDING" && inv.expiresAt && new Date(inv.expiresAt).getTime() < now) {
    return "EXPIRED";
  }
  return inv.status;
}

const secondaryBtn =
  "inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md border border-border-subtle bg-white text-text-main hover:bg-gray-50 transition-colors disabled:opacity-50";

export function InviteRow({
  inv,
  copied,
  busy,
  onCopy,
  onResend,
  onRevoke,
}: {
  inv: Invitation;
  copied: boolean;
  busy: boolean;
  onCopy: () => void;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const status = effectiveStatus(inv);
  const canResend = status === "PENDING" || status === "EXPIRED";
  const canRevoke = status === "PENDING" || status === "EXPIRED";

  return (
    <div
      data-invite-row
      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-border-subtle gap-3 flex-wrap"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-main truncate">{inv.email}</p>
        <p className="text-xs text-text-muted">
          Role: {roleLabel(inv.role)} &middot; Sent {new Date(inv.createdAt).toLocaleDateString()}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        {status === "PENDING" && inv.inviteUrl && (
          <button
            type="button"
            onClick={onCopy}
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
              copied
                ? "bg-green-50 text-green-700 border-green-200"
                : "border-border-subtle bg-white text-text-main hover:bg-gray-50"
            }`}
            title="Copy invite link"
          >
            <span className="material-symbols-outlined text-[16px]">{copied ? "check" : "link"}</span>
            {copied ? "Copied" : "Copy Link"}
          </button>
        )}
        {canResend && (
          <button type="button" onClick={onResend} disabled={busy} className={secondaryBtn} title="Email the invite again with a fresh 7-day link">
            <span className="material-symbols-outlined text-[16px]">send</span>
            Resend
          </button>
        )}
        {canRevoke && (
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className={`${secondaryBtn} hover:text-red-600`}
            title="Cancel this invitation"
          >
            <span className="material-symbols-outlined text-[16px]">block</span>
            Revoke
          </button>
        )}
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider border ${STATUS_STYLES[status] ?? STATUS_STYLES.EXPIRED}`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
      </div>
    </div>
  );
}

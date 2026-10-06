"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { InviteTeamModal } from "@/components/layout/InviteTeamModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RequireMfaToggle } from "./TeamSection.requireMfa";
import { DeactivatedMembers } from "./TeamSection.deactivated";
import { InviteRow, type Invitation } from "./TeamSection.inviteRow";

// ─── Component ──────────────────────────────────────────────────────

export function TeamSection({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Invitation | null>(null);

  const loadInvitations = useCallback(async () => {
    try {
      const data = await api.get<Invitation[]>("/invitations");
      setInvites(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch (err) {
      // Don't pretend the list is empty — say it failed and offer Retry.
      console.warn("[settings/team] failed to load invitations:", err);
      setLoadError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

  const resend = async (inv: Invitation) => {
    setBusyId(inv.id);
    try {
      const res = await api.post<{ emailSent?: boolean }>(`/invitations/${inv.id}/resend`, {});
      if (res?.emailSent === false) {
        onToast("Invite renewed, but the email couldn't be sent — copy the link instead.", "error");
      } else {
        onToast(`Invitation resent to ${inv.email}`, "success");
      }
      await loadInvitations();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't resend the invitation", "error");
    } finally {
      setBusyId(null);
    }
  };

  const confirmRevoke = async () => {
    const inv = revokeTarget;
    setRevokeTarget(null);
    if (!inv) return;
    setBusyId(inv.id);
    try {
      await api.delete(`/invitations/${inv.id}`);
      onToast(`Invitation to ${inv.email} revoked`, "success");
      await loadInvitations();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't revoke the invitation", "error");
    } finally {
      setBusyId(null);
    }
  };

  // Auto-open modal if hash is #invite
  useEffect(() => {
    if (window.location.hash === "#invite") {
      setShowInviteModal(true);
    }
  }, []);

  const copyLink = async (inviteUrl: string, inviteId: string) => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch (err) {
      console.warn("[settings/team] clipboard.writeText failed, falling back to execCommand:", err);
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = inviteUrl;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (copyErr) {
        console.warn("[settings/team] execCommand('copy') fallback failed:", copyErr);
      }
      document.body.removeChild(ta);
    }
    setCopiedId(inviteId);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <>
      <section
        id="section-team"
        className="bg-surface-card rounded-xl border border-border-subtle shadow-card overflow-hidden scroll-mt-6"
      >
        <div className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary-light rounded-lg text-primary border border-primary/20">
              <span className="material-symbols-outlined text-[20px] block">group</span>
            </div>
            <div>
              <h2 className="text-base font-bold text-text-main">Team &amp; Invitations</h2>
              <p className="text-xs text-text-muted">
                Invite analysts and partners to your organization.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowInviteModal(true)}
            className="px-4 py-2 text-white text-sm font-semibold rounded-lg shadow-card transition-colors flex items-center gap-2"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">person_add</span>
            Invite Team Member
          </button>
        </div>
        <div className="p-6">
          {loading && invites.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-4">Loading invitations...</p>
          ) : loadError ? (
            <div className="text-center py-6">
              <span className="material-symbols-outlined text-red-500 text-[32px]">error</span>
              <p className="text-sm text-text-main mt-2">Couldn&apos;t load invitations.</p>
              <p className="text-xs text-text-muted">{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  setLoadError(null);
                  void loadInvitations();
                }}
                className="mt-3 px-4 py-2 text-white text-sm font-semibold rounded-lg"
                style={{ backgroundColor: "#003366" }}
              >
                Retry
              </button>
            </div>
          ) : invites.length === 0 ? (
            <div className="text-center py-6">
              <span className="material-symbols-outlined text-text-muted text-[40px]">
                group_add
              </span>
              <p className="text-sm text-text-muted mt-2">No invitations sent yet.</p>
              <p className="text-xs text-text-muted">
                Click &quot;Invite Team Member&quot; to add your first analyst.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {invites.map((inv) => (
                <InviteRow
                  key={inv.id}
                  inv={inv}
                  copied={copiedId === inv.id}
                  busy={busyId === inv.id}
                  onCopy={() => inv.inviteUrl && copyLink(inv.inviteUrl, inv.id)}
                  onResend={() => resend(inv)}
                  onRevoke={() => setRevokeTarget(inv)}
                />
              ))}
            </div>
          )}
          <RequireMfaToggle onToast={onToast} />
          <DeactivatedMembers onToast={onToast} />
        </div>
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke invitation?"
        message={`${revokeTarget?.email ?? "This person"} won't be able to use their invite link any more. You can invite them again later.`}
        confirmLabel="Revoke invite"
        variant="danger"
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />

      {showInviteModal && (
        <InviteTeamModal
          onClose={() => {
            setShowInviteModal(false);
            // Refresh the list after closing to pick up any new invites
            loadInvitations();
          }}
        />
      )}
    </>
  );
}

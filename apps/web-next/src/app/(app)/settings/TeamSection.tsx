"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { InviteTeamModal } from "@/components/layout/InviteTeamModal";
import { RequireMfaToggle } from "./TeamSection.requireMfa";

// ─── Types ──────────────────────────────────────────────────────────

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: "PENDING" | "ACCEPTED" | "EXPIRED";
  inviteUrl?: string;
  createdAt: string;
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  ACCEPTED: "bg-green-50 text-green-700 border-green-200",
  EXPIRED: "bg-gray-50 text-gray-600 border-gray-200",
};

// ─── Component ──────────────────────────────────────────────────────

export function TeamSection({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadInvitations = useCallback(async () => {
    try {
      const data = await api.get<Invitation[]>("/invitations");
      setInvites(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("[settings/team] failed to load invitations:", err);
      setInvites([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

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
          {loading ? (
            <p className="text-sm text-text-muted text-center py-4">Loading invitations...</p>
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
                <div
                  key={inv.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-border-subtle gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-main truncate">{inv.email}</p>
                    <p className="text-xs text-text-muted">
                      Role: {inv.role} &middot; Sent{" "}
                      {new Date(inv.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {inv.status === "PENDING" && inv.inviteUrl && (
                      <button
                        type="button"
                        onClick={() => copyLink(inv.inviteUrl!, inv.id)}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors ${
                          copiedId === inv.id
                            ? "bg-green-50 text-green-700 border-green-200"
                            : "border-border-subtle bg-white text-text-main hover:bg-gray-50"
                        }`}
                        title="Copy invite link"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {copiedId === inv.id ? "check" : "link"}
                        </span>
                        {copiedId === inv.id ? "Copied" : "Copy Link"}
                      </button>
                    )}
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider border ${
                        STATUS_STYLES[inv.status] || STATUS_STYLES.EXPIRED
                      }`}
                    >
                      {inv.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <RequireMfaToggle onToast={onToast} />
        </div>
      </section>

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

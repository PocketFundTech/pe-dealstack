"use client";

// Manage Team modal — port of deal-team.js showShareModal (legacy
// vanilla-JS implementation), folded into a single React component.
//
// Capabilities (parity with legacy + the chat-agent assign flow):
//  1. Lists current DealTeamMember rows with role + remove + role-change.
//  2. Adds a new team member from /api/users (org-scoped) via
//     POST /api/deals/:id/team { userId, role }.
//  3. Sets Lead Partner / Analyst on the deal. Important: the Deal table has
//     NO leadPartnerId / analystId columns. The chat agent
//     (apps/api/src/services/agents/dealChatAgent/tools.ts:276) treats
//     `leadPartner` as DealTeamMember with role=LEAD and `analyst` as
//     role=MEMBER. We mirror that here so this modal supersedes the broken
//     chat-driven flow without inventing new endpoints.
//
// Style follows edit-deal-modal.tsx: fixed overlay, centered card, Esc +
// backdrop close, body scroll lock, Banker Blue (#003366) primary buttons.

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { TeamMember } from "./deal-detail-shared";

type Role = "LEAD" | "MEMBER" | "VIEWER";

interface OrgUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  title?: string;
  department?: string;
}

// API team-member shape — matches GET /api/deals/:id/team (nested user join).
interface ApiTeamMember {
  id: string;
  role: Role;
  addedAt?: string;
  user: {
    id: string;
    name: string;
    avatar?: string;
    email?: string;
    title?: string;
  };
}

const ROLE_LABEL: Record<Role, string> = {
  LEAD: "Lead Partner",
  MEMBER: "Analyst",
  VIEWER: "Viewer",
};

function initials(name?: string): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();
}

export function ManageTeamModal({
  dealId,
  initialTeam,
  onClose,
  onTeamChanged,
}: {
  dealId: string;
  initialTeam: TeamMember[];
  onClose: () => void;
  onTeamChanged: (team: TeamMember[]) => void;
}) {
  const [teamMembers, setTeamMembers] = useState<ApiTeamMember[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<Role>("MEMBER");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);

  // Fetch authoritative team + users once on open. We seed with `initialTeam`
  // shape just so the avatar list isn't empty during fetch, but the canonical
  // source is GET /deals/:id/team (which returns the nested user join).
  const fetchAll = async () => {
    setLoading(true);
    setError("");
    try {
      const [teamData, userData] = await Promise.all([
        api.get<ApiTeamMember[]>(`/deals/${dealId}/team`),
        api.get<OrgUser[]>(`/users`),
      ]);
      setTeamMembers(Array.isArray(teamData) ? teamData : []);
      setUsers(Array.isArray(userData) ? userData : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  // Push changes up to the deal page so the avatar stack refreshes immediately.
  useEffect(() => {
    onTeamChanged(
      teamMembers.map((m) => ({
        id: m.user?.id || m.id,
        name: m.user?.name || "",
        email: m.user?.email,
        avatar: m.user?.avatar,
        role: m.role,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamMembers]);

  // Body scroll lock + Esc-to-close — matches edit-deal-modal pattern.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Filter eligible users: not already on team + matches search.
  const teamUserIds = useMemo(
    () => new Set(teamMembers.map((m) => m.user?.id).filter(Boolean) as string[]),
    [teamMembers]
  );

  const availableUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => !teamUserIds.has(u.id))
      .filter((u) => {
        if (!q) return true;
        return (
          u.name?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.title?.toLowerCase().includes(q)
        );
      });
  }, [users, teamUserIds, search]);

  const handleAdd = async () => {
    if (!selectedUserId) {
      setError("Pick a user to add");
      return;
    }
    setError("");
    setInfo("");
    setSubmitting(true);
    try {
      const newMember = await api.post<ApiTeamMember>(`/deals/${dealId}/team`, {
        userId: selectedUserId,
        role: selectedRole,
      });
      setTeamMembers((prev) => [...prev, newMember]);
      setSelectedUserId("");
      setSearch("");
      setInfo(`Added as ${ROLE_LABEL[selectedRole]}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add team member");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (memberId: string, role: Role) => {
    setError("");
    setInfo("");
    try {
      const updated = await api.patch<ApiTeamMember>(
        `/deals/${dealId}/team/${memberId}`,
        { role }
      );
      setTeamMembers((prev) =>
        prev.map((m) => (m.id === memberId ? { ...m, ...updated } : m))
      );
      setInfo(`Role updated to ${ROLE_LABEL[role]}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    }
  };

  const requestRemove = (memberId: string, memberName: string) => {
    setPendingRemove({ id: memberId, name: memberName });
  };

  const confirmRemove = async () => {
    const target = pendingRemove;
    if (!target) return;
    setPendingRemove(null);
    setError("");
    setInfo("");
    try {
      await api.delete(`/deals/${dealId}/team/${target.id}`);
      setTeamMembers((prev) => prev.filter((m) => m.id !== target.id));
      setInfo("Team member removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove team member");
    }
  };

  const leadCount = teamMembers.filter((m) => m.role === "LEAD").length;

  // Render
  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full my-8 flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-border-subtle flex items-center justify-between">
          <h3 className="font-bold text-text-main text-base flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">group</span>
            Manage Deal Team
          </h3>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-main transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-text-muted text-sm">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading team...
            </div>
          ) : (
            <>
              {/* Current team */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-text-main">
                    Current Team ({teamMembers.length})
                  </h4>
                  {leadCount > 1 && (
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                      {leadCount} leads
                    </span>
                  )}
                </div>
                {teamMembers.length === 0 ? (
                  <p className="text-sm text-text-muted italic px-3 py-4 bg-gray-50 rounded-lg">
                    No team members yet. Add the first one below.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {teamMembers.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="size-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                            {initials(member.user?.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-text-main truncate">
                              {member.user?.name || "Unknown"}
                            </p>
                            <p className="text-xs text-text-muted truncate">
                              {member.user?.email || ""}
                              {member.user?.title ? ` • ${member.user.title}` : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <select
                            value={member.role}
                            onChange={(e) => handleRoleChange(member.id, e.target.value as Role)}
                            className="px-2 py-1 border border-border-subtle rounded text-xs bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary"
                          >
                            <option value="LEAD">Lead Partner</option>
                            <option value="MEMBER">Analyst</option>
                            <option value="VIEWER">Viewer</option>
                          </select>
                          <button
                            onClick={() => requestRemove(member.id, member.user?.name || "this team member")}
                            className="p-1 text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                            title="Remove from team"
                          >
                            <span className="material-symbols-outlined text-sm">close</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add member */}
              <div className="border-t border-border-subtle pt-5">
                <h4 className="text-sm font-semibold text-text-main mb-3">
                  Add Team Member
                </h4>
                <p className="text-xs text-text-muted mb-3">
                  Roles: <strong>Lead Partner</strong> drives the deal; <strong>Analyst</strong> is a
                  contributing team member; <strong>Viewer</strong> has read-only access.
                </p>

                <div className="mb-3">
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    Search org users
                  </label>
                  <div className="relative">
                    <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[18px] pointer-events-none">
                      search
                    </span>
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by name, email, or title..."
                      className="w-full pl-9 pr-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                </div>

                <div className="mb-3 max-h-48 overflow-y-auto border border-border-subtle rounded-lg">
                  {availableUsers.length === 0 ? (
                    <p className="text-sm text-text-muted italic p-3 text-center">
                      {users.length === 0
                        ? "No users in your organization yet."
                        : search
                        ? "No users match your search."
                        : "Everyone is already on the team."}
                    </p>
                  ) : (
                    <ul>
                      {availableUsers.map((u) => {
                        const selected = u.id === selectedUserId;
                        return (
                          <li key={u.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedUserId(u.id)}
                              className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                                selected
                                  ? "bg-primary/10 text-primary"
                                  : "hover:bg-gray-50 text-text-main"
                              }`}
                            >
                              <div className="size-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold shrink-0">
                                {initials(u.name)}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="font-medium truncate">{u.name}</p>
                                <p className="text-xs text-text-muted truncate">
                                  {u.email}
                                  {u.title ? ` • ${u.title}` : ""}
                                </p>
                              </div>
                              {selected && (
                                <span className="material-symbols-outlined text-primary text-base">
                                  check_circle
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value as Role)}
                    disabled={!selectedUserId || submitting}
                    className="px-3 py-2 border border-border-subtle rounded-lg text-sm bg-white focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:opacity-50"
                  >
                    <option value="LEAD">Lead Partner</option>
                    <option value="MEMBER">Analyst</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                  <button
                    onClick={handleAdd}
                    disabled={!selectedUserId || submitting}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-white rounded-lg font-medium text-sm disabled:opacity-50 transition-colors"
                    style={{ backgroundColor: "#003366" }}
                  >
                    <span className="material-symbols-outlined text-[18px]">person_add</span>
                    {submitting ? "Adding..." : "Add to Team"}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 mt-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <span className="material-symbols-outlined text-red-500 text-sm">error</span>
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
              {info && !error && (
                <div className="flex items-center gap-2 mt-4 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <span className="material-symbols-outlined text-green-600 text-sm">
                    check_circle
                  </span>
                  <p className="text-sm text-green-700">{info}</p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-5 border-t border-border-subtle flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2.5 border border-border-subtle rounded-lg font-medium text-sm hover:bg-gray-50 transition-colors"
          >
            Done
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove team member"
        message={`Remove ${pendingRemove?.name ?? "this team member"} from the deal team?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/providers/UserProvider";

// Deactivated teammates (self-deactivated, QA #16, or removed by an admin)
// with a Reactivate button: PATCH /api/users/:id { isActive: true }. Needs
// USER_EDIT, which only ADMIN and OPS hold. Their API keys and integrations
// were revoked at deactivation, so they reconnect those themselves.

interface DeactivatedUser {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
}

const USER_EDIT_ROLES: Array<string> = ["ADMIN", "OPS"];

export function DeactivatedMembers({
  onToast,
}: {
  onToast: (msg: string, type: "success" | "error") => void;
}) {
  const { user } = useUser();
  const canEdit = USER_EDIT_ROLES.includes((user?.systemRole || "").toUpperCase());
  const [users, setUsers] = useState<DeactivatedUser[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await api.get<DeactivatedUser[]>("/users?isActive=false"));
    } catch (err) {
      console.warn("[settings/team/deactivated] load failed:", err);
    }
  }, []);

  useEffect(() => {
    if (canEdit) void load();
  }, [canEdit, load]);

  if (!canEdit || users.length === 0) return null;

  const reactivate = async (u: DeactivatedUser) => {
    setBusyId(u.id);
    try {
      await api.patch(`/users/${u.id}`, { isActive: true });
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      onToast(`${u.name || u.email} can sign in again`, "success");
    } catch (err) {
      onToast(`Could not reactivate: ${err instanceof Error ? err.message : "unknown error"}`, "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-text-main mb-2">Deactivated members</h3>
      <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-text-main">{u.name || u.email}</p>
              <p className="truncate text-xs text-text-muted">
                {u.email}
                {u.role ? ` · ${u.role.toLowerCase()}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => reactivate(u)}
              disabled={busyId === u.id}
              className="shrink-0 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-gray-50 disabled:opacity-50"
            >
              {busyId === u.id ? "Reactivating…" : "Reactivate"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

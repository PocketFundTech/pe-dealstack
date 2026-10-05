"use client";

import { DEFAULT_INVITE_ROLE, ROLE_OPTIONS, type ApiRole } from "@/lib/roles";
import { TaskModalShell } from "./task-modal-shell";
import { TeamInvite } from "./types";

// Team invite task — dynamic rows of (email, role). "Send invites" POSTs
// each filled row to /invitations (the parent page does the sending and
// keeps failed rows here so they can be fixed); "Skip for now" completes the
// task without inviting anyone. Role options come from the shared role map
// so what the user picks here is what the team list shows later.
export function TeamTaskModal({
  invites,
  onChange,
  onClose,
  onComplete,
  onSkip,
  busy = false,
  canInviteAdmins = false,
}: {
  invites: TeamInvite[];
  onChange: (v: TeamInvite[]) => void;
  onClose: () => void;
  onComplete: () => void;
  onSkip: () => void;
  busy?: boolean;
  canInviteAdmins?: boolean;
}) {
  const updateRow = (i: number, patch: Partial<TeamInvite>) => {
    const next = invites.map((row, idx) => (idx === i ? { ...row, ...patch } : row));
    onChange(next);
  };

  const addRow = () => onChange([...invites, { email: "", role: DEFAULT_INVITE_ROLE }]);
  const removeRow = (i: number) => onChange(invites.filter((_, idx) => idx !== i));

  // Only ADMINs may invite ADMINs (API returns 403 otherwise) — don't offer it.
  const roleOptions = ROLE_OPTIONS.filter((r) => canInviteAdmins || r.value !== "ADMIN");
  const hasEmail = invites.some((r) => r.email.trim() !== "");

  return (
    <TaskModalShell
      icon="group_add"
      title="Invite your team"
      onClose={onClose}
      onComplete={onComplete}
      completeLabel="Send invites"
      busyLabel="Sending..."
      canComplete={hasEmail}
      busy={busy}
      secondaryAction={{ label: "Skip for now", onClick: onSkip }}
    >
      <p className="text-[13.5px] text-text-secondary mb-4">
        Invite your deal team. They&apos;ll get an email and see the same AI findings.
      </p>

      <div className="space-y-2 mb-3">
        {invites.map((row, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input
              type="email"
              value={row.email}
              onChange={(e) => updateRow(i, { email: e.target.value })}
              placeholder="teammate@firm.com"
              aria-label={`Teammate ${i + 1} email`}
              disabled={busy}
              className="flex-1 px-3 py-2.5 text-[13px] rounded-lg border border-border-subtle focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
            />
            <select
              value={row.role}
              onChange={(e) => updateRow(i, { role: e.target.value as ApiRole })}
              aria-label={`Teammate ${i + 1} role`}
              disabled={busy}
              className="w-32 px-3 py-2.5 text-[13px] rounded-lg border border-border-subtle focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none bg-white"
            >
              {roleOptions.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {invites.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="p-2 text-text-muted hover:text-red-500 transition-colors"
                aria-label="Remove invite"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRow}
        className="text-[13px] text-primary font-semibold flex items-center gap-1 hover:text-primary-hover"
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        Add another
      </button>
    </TaskModalShell>
  );
}

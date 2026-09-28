"use client";

import { formatCurrency } from "@/lib/formatters";
import type { AdminDeal, AdminTeamMember } from "./types";

// ─── Shared form primitives ──────────────────────────────────────────

export const INPUT_CLS =
  "w-full rounded-md border border-(--dash-rule-strong) bg-(--dash-panel) px-3 py-2 text-sm text-(--dash-ink) placeholder:text-(--dash-ink-3) outline-none transition-colors focus:border-(--dash-blue-2) focus:ring-2 focus:ring-(--dash-blue-5)";
export const LABEL_CLS = "mb-1.5 block text-[0.8125rem] font-medium text-(--dash-ink)";
export const BTN_PRIMARY = "dash-btn-primary rounded-md px-4 py-2 text-sm font-semibold";
export const BTN_SECONDARY = "rounded-md px-3.5 py-2 text-sm font-medium text-(--dash-ink-2) hover:bg-(--dash-wash) hover:text-(--dash-ink)";

/** Values an action can be opened with, e.g. from a row's "Nudge". */
export interface ActionPrefill {
  dealId?: string;
  userId?: string;
  message?: string;
  title?: string;
}

export function DealOptions({ deals }: { deals: AdminDeal[] }) {
  return (
    <>
      <option value="">Choose a deal...</option>
      {deals.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
          {d.dealSize ? ` - ${formatCurrency(d.dealSize)}` : ""}
        </option>
      ))}
    </>
  );
}

export function UserOptions({ users }: { users: AdminTeamMember[] }) {
  return (
    <>
      <option value="">Choose a team member...</option>
      {users.map((u) => {
        const label = u.name || u.email.split("@")[0];
        const raw = u.title || u.role || "";
        // "MEMBER" → "Member"; job titles like "Analyst" pass through.
        const role = raw === raw.toUpperCase() ? raw.charAt(0) + raw.slice(1).toLowerCase() : raw;
        return (
          <option key={u.id} value={u.id}>
            {label}
            {role ? ` · ${role}` : ""}
          </option>
        );
      })}
    </>
  );
}

export interface SharedProps {
  open: boolean;
  onClose: () => void;
  deals: AdminDeal[];
  users: AdminTeamMember[];
  onToast: (msg: string, type: "success" | "error") => void;
  prefill?: ActionPrefill;
}

"use client";

import Link from "next/link";
import { useUser } from "@/providers/UserProvider";
import { useIngestDealModal } from "@/providers/IngestDealModalProvider";
import { WidgetShell } from "./shell";

// Ported from quick-actions.js.
// Hides "Create Task" for non-admins.
//
// "New Deal" used to deep-link to /deal-intake. The full-page intake flow has
// since been replaced with a modal opened via IngestDealModalProvider, so the
// quick action now triggers the modal instead of navigating.

interface QuickAction {
  icon: string;
  label: string;
  href?: string;
  /** When set, the action runs `onClick` and the tile is rendered as a
   *  <button> instead of a <Link>. */
  onClick?: () => void;
}

const ADMIN_ROLES = new Set(["ADMIN", "PARTNER", "PRINCIPAL"]);

export function QuickActionsWidget() {
  const { user } = useUser();
  const { openDealIntake } = useIngestDealModal();
  const isAdmin = user?.role ? ADMIN_ROLES.has(user.role.toUpperCase()) : false;

  const actions: QuickAction[] = [
    { icon: "add_circle", label: "New Deal", onClick: openDealIntake },
    { icon: "upload_file", label: "Upload Doc", href: "/data-room" },
    { icon: "person_add", label: "Add Contact", href: "/contacts" },
  ];
  if (isAdmin) {
    actions.push({ icon: "task_alt", label: "Create Task", href: "/admin" });
  }

  return (
    <WidgetShell title="Quick Actions" icon="bolt">
      <ul className="flex flex-col divide-y divide-(--dash-rule)">
        {actions.map((a) => {
          const className =
            "group flex w-full items-center gap-3 px-5 py-3 text-left text-sm text-(--dash-ink) transition-colors hover:bg-(--dash-wash)";
          const inner = (
            <>
              <span className="material-symbols-outlined text-[18px] text-(--dash-blue-2)">{a.icon}</span>
              <span className="flex-1 font-medium">{a.label}</span>
              <span className="material-symbols-outlined text-[16px] text-(--dash-ink-3) transition-transform group-hover:translate-x-0.5 group-hover:text-(--dash-blue)">
                arrow_forward
              </span>
            </>
          );
          return (
            <li key={a.label}>
              {a.onClick ? (
                <button type="button" onClick={a.onClick} className={className}>{inner}</button>
              ) : (
                <Link href={a.href!} className={className}>{inner}</Link>
              )}
            </li>
          );
        })}
      </ul>
    </WidgetShell>
  );
}

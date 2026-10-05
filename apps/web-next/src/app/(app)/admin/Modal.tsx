"use client";

import type { ReactNode } from "react";
import { SideSheet } from "@/components/dash/side-sheet";

// Shell for the four Command Center actions (assign, task, review, reminder).
// Renders as the shared right-side sheet so the page stays visible behind
// it; name kept as `Modal` so the action components didn't need to change.

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Short context line under the title (e.g. "For Harish"). */
  subtitle?: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}

export function Modal({ open, onClose, title, subtitle, children, footer }: Props) {
  return (
    <SideSheet open={open} onClose={onClose} eyebrow="Command Center" title={title} subtitle={subtitle} footer={footer}>
      <div className="flex flex-col gap-5 px-6 py-5">{children}</div>
    </SideSheet>
  );
}

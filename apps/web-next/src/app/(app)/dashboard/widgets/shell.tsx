"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";

// Card shell + loading/error/empty renderers — ported from WidgetBase
// (widget-base.js, c9dcc6d).
export function WidgetShell({
  title,
  children,
  headerRight,
  className,
}: {
  title: string;
  /** Kept for API compatibility; the redesigned header is type-only. */
  icon?: string;
  children: ReactNode;
  headerRight?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("dash-panel flex flex-col overflow-hidden", className)}>
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-(--dash-rule)">
        <h3 className="dash-display text-lg text-(--dash-ink)">{title}</h3>
        {headerRight}
      </header>
      {children}
    </section>
  );
}

export function WidgetLoading() {
  return (
    <div className="px-5 py-6 flex flex-col gap-2.5" aria-label="Loading">
      <Skeleton.Line width="70%" height={12} />
      <Skeleton.Line width="55%" height={12} />
      <Skeleton.Line width="62%" height={12} />
    </div>
  );
}

export function WidgetEmpty({ message }: { message: string; icon?: string }) {
  return <p className="px-5 py-6 text-sm text-(--dash-ink-2)">{message}</p>;
}

export function WidgetError({ message = "Could not load" }: { message?: string }) {
  return (
    <p className="px-5 py-6 text-sm text-(--dash-red) flex items-center gap-2">
      <span className="material-symbols-outlined text-[16px]">cloud_off</span>
      {message}
    </p>
  );
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

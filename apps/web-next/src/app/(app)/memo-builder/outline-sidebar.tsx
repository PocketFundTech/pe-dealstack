"use client";

import { LegalDocsPanel } from "@/components/memo-builder/LegalDocsPanel";
import { cn } from "@/lib/cn";
import type { MemoSection } from "./components";

/**
 * Honest compliance status: only claim anything about citations when there
 * is generated content to check. Sections that failed to generate (empty, or
 * showing a placeholder) don't count.
 */
export function complianceMessage(sections: MemoSection[]): string {
  const generated = sections.filter(
    (s) => s.aiGenerated && !s.hasPlaceholder && (s.content ?? "").trim().length > 0,
  );
  if (generated.length === 0) {
    return "No generated sections yet — nothing to verify.";
  }
  const withCitations = generated.filter((s) => (s.citations?.length ?? 0) > 0);
  if (withCitations.length === 0) {
    return "Generated sections have no citations — nothing to verify.";
  }
  const total = withCitations.reduce((n, s) => n + (s.citations?.length ?? 0), 0);
  return `${total} citation${total === 1 ? "" : "s"} across ${withCitations.length} of ${generated.length} generated section${generated.length === 1 ? "" : "s"}. Review sources before sharing.`;
}

interface MemoOutlineSidebarProps {
  sections: MemoSection[];
  activeSection: string | null;
  setActiveSection: (id: string | null) => void;
  onAddSection: () => void;
  templateName?: string;
  /** When set, render a compact NDA/legal-docs list near the bottom. */
  dealId?: string;
}

export function MemoOutlineSidebar({
  sections,
  activeSection,
  setActiveSection,
  onAddSection,
  templateName,
  dealId,
}: MemoOutlineSidebarProps) {
  return (
    <aside className="hidden md:flex w-64 bg-slate-50 border-r border-slate-200 flex-col shrink-0">
      {/* Sections outline */}
      <div className="p-4 border-b border-slate-100 flex-1 overflow-y-auto custom-scrollbar">
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
          Sections
        </h3>
        <nav className="flex flex-col gap-1">
          {sections.map((section) => {
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                onClick={() => {
                  setActiveSection(section.id);
                  document
                    .getElementById(`section-${section.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left group",
                  isActive
                    ? "bg-white shadow-sm border border-slate-200 text-primary"
                    : "text-slate-700 hover:bg-slate-100"
                )}
              >
                <div className="flex items-center gap-2 truncate">
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px]",
                      isActive
                        ? "text-primary"
                        : "text-slate-400 group-hover:text-primary"
                    )}
                  >
                    drag_indicator
                  </span>
                  <span className="truncate">{section.title}</span>
                </div>
                {isActive && (
                  <div className="size-1.5 rounded-full bg-primary shrink-0" />
                )}
              </button>
            );
          })}
        </nav>
        {sections.length === 0 && (
          <p className="text-[11px] text-text-muted text-center py-6">No sections yet</p>
        )}
        <button
          onClick={onAddSection}
          className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-500 hover:text-primary hover:bg-white border border-dashed border-slate-300 hover:border-primary rounded-lg transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          Add Section
        </button>
      </div>

      {/* Memo Templates + Compliance cards */}
      <div className="p-4 shrink-0 space-y-3">
        <a
          href="/templates"
          className="block bg-white rounded-lg p-3 border border-slate-200 hover:border-primary/50 hover:shadow-sm transition-all group"
        >
          <div className="flex items-center gap-2 text-slate-700 group-hover:text-primary font-semibold text-xs mb-1">
            <span className="material-symbols-outlined text-[16px]">description</span>
            <span>Memo Templates</span>
          </div>
          {/* "Standard IC Memo" used to show here even with no real template
              record behind it — Change Template then landed on an empty
              /templates page with nothing to switch to (QA 2026-10-11, AI
              Reports finding A). Only claim a name when one is real. */}
          <p className="text-[11px] text-slate-500 mb-2">
            {templateName ? (
              <>
                Using:{" "}
                <span className="font-medium text-slate-700">{templateName}</span>
              </>
            ) : (
              "No custom template — using the default section outline."
            )}
          </p>
          <div className="flex items-center gap-1 text-[10px] text-primary font-medium group-hover:underline">
            <span>{templateName ? "Change Template" : "Browse Templates"}</span>
            <span className="material-symbols-outlined text-[12px]">chevron_right</span>
          </div>
        </a>

        <div className="bg-primary-light rounded-lg p-3 border border-primary/20">
          <div className="flex items-center gap-2 text-primary font-semibold text-xs mb-1">
            <span className="material-symbols-outlined text-[16px]">verified_user</span>
            <span>Compliance Check</span>
          </div>
          <p className="text-[11px] text-primary/70" data-testid="compliance-status">
            {complianceMessage(sections)}
          </p>
        </div>

        {dealId && <LegalDocsPanel dealId={dealId} />}
      </div>
    </aside>
  );
}

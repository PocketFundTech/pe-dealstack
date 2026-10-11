"use client";

import React, { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { cn } from "@/lib/cn";
import type { Memo, MemoSection, TableData, TableRow } from "./components";

// Allowlist-based HTML sanitization via DOMPurify. Permits only safe tags
// and attributes — strips scripts, iframes, event handlers, javascript: URIs, etc.
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "b", "i", "br", "div", "span", "table", "thead", "tbody", "tr", "th", "td", "a", "blockquote", "code", "pre", "button"],
    ALLOWED_ATTR: ["class", "href", "target", "rel", "data-source", "data-page", "title"],
  });
}

/* ---- Table rendering helper ---- */
function renderTableData(tableData: TableData) {
  if (!tableData.headers || !tableData.rows) return null;

  return (
    <div className="overflow-hidden border border-slate-200 rounded-lg bg-white shadow-sm mb-6">
      <table className="w-full text-sm text-left">
        <thead className="bg-slate-50 text-slate-500 font-medium border-b border-slate-200">
          <tr>
            {tableData.headers.map((h, i) => (
              <th
                key={i}
                className={cn(
                  "px-4 py-3 font-semibold",
                  i === 0 ? "w-1/3 text-left" : "text-right"
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tableData.rows.map((row, rowIdx) => {
            let metric = "";
            let values: string[] = [];
            let isBold = false;
            let isSubMetric = false;

            if (Array.isArray(row)) {
              metric = (row as string[])[0] || "";
              values = (row as string[]).slice(1);
              const ml = metric.toLowerCase();
              isBold = ml.includes("ebitda") || ml.includes("total") || ml.includes("net income");
              isSubMetric = ml.includes("margin") || ml.includes("growth") || ml.includes("%");
            } else {
              const r = row as TableRow;
              metric = r.metric || "";
              values = Array.isArray(r.values) ? r.values : [];
              isBold = !!r.isBold;
              isSubMetric = !!r.isSubMetric;
            }

            return (
              <tr
                key={rowIdx}
                className={cn(
                  "hover:bg-slate-50/50",
                  isBold && "bg-slate-50/30"
                )}
              >
                <td
                  className={cn(
                    "px-4 py-2.5",
                    isBold ? "font-bold text-slate-900" : isSubMetric ? "pl-8 text-slate-500 italic" : "font-medium text-slate-800"
                  )}
                >
                  {metric}
                </td>
                {values.map((v, ci) => (
                  <td
                    key={ci}
                    className={cn(
                      "px-4 py-2.5 text-right font-mono",
                      isBold ? "font-semibold text-slate-800" : isSubMetric ? "text-slate-500" : "text-slate-600"
                    )}
                  >
                    {v ?? ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {tableData.footnote && (
        <div className="bg-slate-50 border-t border-slate-200 px-4 py-2">
          <p className="text-[10px] text-slate-500">{tableData.footnote}</p>
        </div>
      )}
    </div>
  );
}

function formatDocDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return `Date: ${d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`;
}

/* ------------------------------------------------------------------ */
/*  MemoEditor — document canvas layout                                */
/* ------------------------------------------------------------------ */

export interface MemoEditorProps {
  memo: Memo;
  sections: MemoSection[];
  activeSection: string | null;
  setActiveSection: (id: string | null) => void;
  editingContent: Record<string, string>;
  setEditingContent: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  generatingSection: string | null;
  savingSection: string | null;
  onGenerate: (sectionId: string) => void;
  onSave: (sectionId: string) => void;
  onDelete: (section: { id: string; title: string }) => void;
}

export function MemoEditor({
  memo,
  sections,
  activeSection,
  setActiveSection,
  editingContent,
  setEditingContent,
  generatingSection,
  savingSection,
  onGenerate,
  onSave,
  onDelete,
}: MemoEditorProps) {
  const containerRef = useRef<HTMLElement | null>(null);

  // Scroll-spy: mark the section closest to the top as active so the outline
  // highlight follows the reader.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || sections.length === 0) return;
    const onScroll = () => {
      const offset = el.getBoundingClientRect().top + 100;
      let current = sections[0].id;
      for (const s of sections) {
        const node = document.getElementById(`section-${s.id}`);
        if (node && node.getBoundingClientRect().top <= offset) current = s.id;
      }
      if (current !== activeSection) setActiveSection(current);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [sections, activeSection, setActiveSection]);

  // Estimate page count from content height
  const pageCount = Math.max(1, Math.ceil((sections.length * 400) / 1056));

  return (
    <main
      ref={containerRef}
      className="flex-1 min-w-0 overflow-auto custom-scrollbar flex justify-center items-start p-8"
      style={{ backgroundColor: "#e8eaed" }}
    >
      <div
        className="w-full max-w-[850px] min-w-[560px] shrink-0 bg-white flex flex-col [overflow-wrap:break-word] [word-break:normal]"
        style={{
          boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 4px 16px rgba(0,0,0,0.10)",
          borderRadius: "2px",
          minHeight: "calc(100vh - 120px)",
        }}
      >
        {/* Document header */}
        <div className="px-14 pt-14 pb-6 border-b border-slate-200">
          <h1
            className="font-bold text-[#1a1a2e] mb-3 leading-tight"
            style={{ fontSize: "26px", letterSpacing: "-0.02em" }}
          >
            {memo.title || "Investment Committee Memo"}
          </h1>
          <div className="flex items-center flex-wrap gap-x-5 gap-y-1 text-[13px] text-slate-500">
            {memo.projectName && (
              <span className="font-semibold text-slate-800">{memo.projectName}</span>
            )}
            <span className="text-slate-300">|</span>
            <span>{formatDocDate(memo.updatedAt)}</span>
            {memo.sponsor && (
              <>
                <span className="text-slate-300">|</span>
                <span>Sponsor: {memo.sponsor}</span>
              </>
            )}
          </div>
        </div>

        {/* Document body — sections rendered continuously */}
        <div className="px-14 py-10 flex-1 flex flex-col gap-10">
          {sections.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <span className="material-symbols-outlined text-4xl text-text-muted mb-2">
                article
              </span>
              <p className="text-sm font-medium text-text-main mb-1">No sections</p>
              <p className="text-xs text-text-muted">
                This memo has no sections yet. Use &ldquo;Add Section&rdquo; in the outline sidebar.
              </p>
            </div>
          ) : (
            sections.map((section, index) => (
              <DocSection
                key={section.id}
                section={section}
                index={index}
                isActive={activeSection === section.id}
                content={editingContent[section.id] || ""}
                onContentChange={(val) =>
                  setEditingContent((prev) => ({ ...prev, [section.id]: val }))
                }
                generating={generatingSection === section.id}
                saving={savingSection === section.id}
                onGenerate={() => onGenerate(section.id)}
                onSave={() => onSave(section.id)}
                onDelete={() => onDelete({ id: section.id, title: section.title })}
              />
            ))
          )}
        </div>

        {/* Document footer — matches legacy: bg-slate-50/50, CONFIDENTIAL text */}
        <div className="px-14 py-6 mt-auto" style={{ backgroundColor: "#f9fafb", borderTop: "1px solid #e5e7eb" }}>
          <div className="flex justify-between text-xs text-slate-400">
            <span>CONFIDENTIAL - FOR INTERNAL USE ONLY</span>
            <span>Page 1 of {pageCount}</span>
          </div>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/*  DocSection — one section rendered inside the document canvas       */
/* ------------------------------------------------------------------ */

interface DocSectionProps {
  section: MemoSection;
  index: number;
  isActive: boolean;
  content: string;
  onContentChange: (val: string) => void;
  generating: boolean;
  saving: boolean;
  onGenerate: () => void;
  onSave: () => void;
  onDelete: () => void;
}

function DocSection({
  section,
  index,
  isActive,
  content,
  onContentChange,
  generating,
  saving,
  onGenerate,
  onSave,
  onDelete,
}: DocSectionProps) {
  const [editing, setEditing] = useState(false);
  const hasHtml = /<[a-z][\s\S]*>/i.test(content);

  return (
    <section
      id={`section-${section.id}`}
      className={cn(
        "group/section relative pl-4 -ml-4 transition-colors scroll-mt-8",
        isActive
          ? "border-l-2 border-primary/30 bg-primary/5 p-4 rounded-r-lg"
          : "border-l-2 border-transparent hover:border-slate-200"
      )}
    >
      {/* Section heading — matches legacy: numbered, with AI badge and icon-only action buttons */}
      <div className="flex justify-between items-start mb-3">
        <h2
          className="font-bold text-[15px] text-primary uppercase flex items-center gap-2"
          style={{ letterSpacing: "0.06em" }}
        >
          {index + 1}. {section.title}
          {section.aiGenerated && (
            <span className="bg-purple-100 text-purple-700 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">
              AI Generated
            </span>
          )}
        </h2>
        {/* Action buttons — icon-only compact buttons matching legacy */}
        <div
          className={cn(
            "flex gap-1 transition-opacity",
            isActive ? "opacity-100" : "opacity-0 group-hover/section:opacity-100"
          )}
        >
          <button
            onClick={onGenerate}
            disabled={generating}
            className="p-1.5 rounded hover:bg-blue-100 text-primary hover:text-blue-800 transition-colors disabled:opacity-50"
            title="Regenerate with AI"
          >
            {generating ? (
              <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
            ) : (
              <span className="material-symbols-outlined text-[16px]">refresh</span>
            )}
          </button>
          <button
            onClick={() => setEditing(!editing)}
            className="p-1.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors"
            title="Edit content"
          >
            <span className="material-symbols-outlined text-[16px]">edit_note</span>
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="p-1.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors disabled:opacity-50"
            title="Save section"
          >
            {saving ? (
              <span className="material-symbols-outlined text-[16px] animate-spin">sync</span>
            ) : (
              <span className="material-symbols-outlined text-[16px]">save</span>
            )}
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-600 transition-colors"
            title="Delete section"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      </div>

      {/* Section heading underline — matches legacy #sections-content h2 border-bottom */}
      <div className="border-b-2 border-primary mb-3 -mt-1" />

      {/* Content display or editing */}
      {editing ? (
        <div>
          {hasHtml && (
            <button
              onClick={() => setEditing(false)}
              className="mb-2 text-[11px] font-medium text-primary hover:underline flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">visibility</span>
              Preview
            </button>
          )}
          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            rows={8}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 leading-[1.75] placeholder-slate-400 focus:ring-2 focus:ring-primary/20 focus:border-primary resize-y font-mono"
            placeholder="Write section content here (supports HTML)..."
          />
          <p className="mt-2 text-xs text-slate-400">
            You can use HTML tags like &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;strong&gt; for formatting.
          </p>
        </div>
      ) : hasHtml ? (
        <div
          className="memo-section-content max-w-none"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(content) }}
        />
      ) : content ? (
        <div className="memo-section-content">
          <p>{content}</p>
        </div>
      ) : (
        <div className="p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-center">
          <button
            onClick={onGenerate}
            className="inline-flex flex-col items-center gap-2 text-slate-400 hover:text-primary transition-colors group/add"
          >
            <div className="size-8 rounded-full bg-slate-200 flex items-center justify-center group-hover/add:bg-primary/10 transition-colors">
              <span className="material-symbols-outlined group-hover/add:text-primary">add</span>
            </div>
            <span className="text-sm font-medium">Generate content with AI</span>
          </button>
        </div>
      )}

      {/* Table data rendering */}
      {section.tableData && renderTableData(section.tableData)}

      {/* Placeholder for missing content */}
      {section.hasPlaceholder && section.placeholderText && (
        <div className="p-4 bg-slate-50 rounded-lg border border-dashed border-slate-300 text-center">
          <button className="inline-flex flex-col items-center gap-2 text-slate-400 hover:text-primary transition-colors group/add">
            <div className="size-8 rounded-full bg-slate-200 flex items-center justify-center group-hover/add:bg-primary/10 transition-colors">
              <span className="material-symbols-outlined group-hover/add:text-primary">add</span>
            </div>
            <span className="text-sm font-medium">{section.placeholderText}</span>
          </button>
        </div>
      )}
    </section>
  );
}

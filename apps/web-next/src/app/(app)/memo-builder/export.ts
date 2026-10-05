import DOMPurify from "dompurify";
import type { MemoSection, Memo } from "./components";

// ---------------------------------------------------------------------------
// Markdown / clipboard / share helpers — ported from c1d7a4d's memo-editor.js
// ---------------------------------------------------------------------------

/**
 * Build a Markdown representation of a memo and trigger a .md download.
 */
export function exportMemoMarkdown(
  memo: Memo,
  sections: MemoSection[],
  editingContent: Record<string, string>,
): void {
  const title = memo.projectName || memo.title || "Investment Memo";
  let md = `# ${title} — Investment Committee Memo\n\n`;
  md += `**Date:** ${new Date().toLocaleDateString()}\n\n---\n\n`;

  sections.forEach((section, i) => {
    md += `## ${i + 1}. ${section.title}\n\n`;
    const content = editingContent[section.id] || section.content || "";
    if (content) md += htmlToMarkdown(content) + "\n\n";
  });

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^a-zA-Z0-9]/g, "_")}_IC_Memo.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "### ")
    .replace(/<strong>/gi, "**").replace(/<\/strong>/gi, "**")
    .replace(/<em>/gi, "*").replace(/<\/em>/gi, "*")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Copy the memo's plaintext content to the clipboard.
 * Falls back to execCommand('copy') on browsers without the Clipboard API.
 */
export async function exportMemoClipboard(
  sections: MemoSection[],
  editingContent: Record<string, string>,
): Promise<void> {
  const text = sections
    .map((s, i) => {
      const content = editingContent[s.id] || s.content || "";
      return `${i + 1}. ${s.title}\n${htmlToMarkdown(content)}`;
    })
    .join("\n\n");

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

/**
 * Copy a deep link to a specific memo onto the clipboard.
 * The link uses NEXT_PUBLIC_APP_URL (defaulting to the canonical lmmos.ai
 * production domain) instead of window.location so the link is portable
 * across preview deployments and pinned to the memo, not the bare page.
 */
export async function shareMemoLink(memoId: string): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://lmmos.ai";
  const url = `${appUrl}/memo-builder?memoId=${encodeURIComponent(memoId)}`;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = url;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

/**
 * Strip a section's HTML down to plain text laid out for a text PDF:
 * paragraph/heading/list-item boundaries become blank lines or bullet
 * prefixes, everything else is dropped. Unlike htmlToMarkdown (used for the
 * .md export), this emits no markdown syntax — jsPDF renders exactly the
 * characters it's given, so "**bold**" or "### Heading" would show up
 * literally in the PDF.
 */
function htmlToPlainText(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [] })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** html entity decode happens above; this pass runs BEFORE sanitizing so block boundaries survive tag stripping. */
export function htmlToPlainTextWithLayout(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6])>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "");
  return htmlToPlainText(withBreaks).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Build a memo as a real text-layer PDF via jsPDF's text API (no DOM
 * rasterization) — searchable and copyable, unlike the previous
 * html2pdf.js/html2canvas path which embedded each page as a JPEG
 * screenshot (QA 2026-10-06 #16c).
 */
export async function exportMemoPDF(
  memo: Memo,
  sections: MemoSection[],
  editingContent: Record<string, string>,
) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (lineHeight: number) => {
    if (y + lineHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeLines = (text: string, lineHeight: number) => {
    const lines: string[] = doc.splitTextToSize(text, contentWidth);
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, margin, y);
      y += lineHeight;
    }
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(0, 51, 102);
  writeLines(memo.projectName || memo.title, 7.5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(102, 102, 102);
  writeLines(`${memo.title} · ${new Date().toLocaleDateString()}`, 6);
  y += 4;

  for (const s of sections) {
    const content = editingContent[s.id] || s.content || "(No content)";

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(0, 51, 102);
    writeLines(s.title, 6.5);
    y += 1;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.setTextColor(51, 51, 51);
    writeLines(htmlToPlainTextWithLayout(content), 5.2);
    y += 7;
  }

  doc.save(`${(memo.projectName || memo.title).replace(/[^a-zA-Z0-9]/g, "_")}_Memo.pdf`);
}

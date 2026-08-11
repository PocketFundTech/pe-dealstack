"use client";

import DOMPurify from "dompurify";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";

// Mirrors the broader allowlist in apps/api/src/services/legalDocParseService.ts
// — legal docs need fuller Word-formatting fidelity than memos (highlights,
// underlines, alignment, colors). If you broaden either side, broaden the
// other together.
const ALLOWED_TAGS = [
  "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "u", "s", "strike", "mark",
  "sup", "sub",
  "br", "hr",
  "div", "span",
  "table", "thead", "tbody", "tr", "th", "td",
  "a", "blockquote", "code", "pre", "button",
];
const ALLOWED_ATTR = [
  "class",
  "style",
  "href",
  "target",
  "rel",
  "data-source",
  "data-page",
  "data-gap",
  "title",
  "colspan",
  "rowspan",
];

export function sanitizeLegalHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export interface EditorHandle {
  /**
   * Insert raw HTML at the user's current caret position inside the editor.
   * If the caret isn't currently in the editor (e.g. the user clicked a
   * palette pill which moved focus), we append to the end as a fallback so
   * the user still sees something happen.
   */
  insertHtmlAtCursor: (html: string) => void;
  /** Move focus back into the editor without scrolling the page. */
  focus: () => void;
}

interface EditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Disable typing/edits (e.g. when viewing a SENT snapshot). */
  readOnly?: boolean;
}

// Tracks which inline-format commands the current browser selection falls
// inside (bold / italic / underline) so the toolbar can highlight the
// matching button. Block-level commands (H2/H3/lists) aren't reflected in
// queryCommandState reliably across browsers — we leave those un-highlighted.
interface ToolbarActiveState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

/**
 * ContentEditable rich-text editor for legal documents.
 *
 * Important quirks worth knowing before you change this:
 *   1) We render `value` into `innerHTML` only when the prop differs from the
 *      DOM (`el.innerHTML !== sanitized`). Otherwise every parent re-render
 *      would clobber the user's caret on each keystroke.
 *   2) `onChange` fires sanitized HTML — never the raw DOM contents — so
 *      consumers can persist directly to the API without re-sanitizing.
 *   3) `insertHtmlAtCursor` uses `document.execCommand("insertHTML")`. It's
 *      deprecated but it's still the only cross-browser way to splice HTML
 *      at the caret inside a contentEditable. The replacement Editing API
 *      (Selection.modify + Range.insertNode) doesn't fire input events on
 *      Firefox, which would break our onChange contract.
 */
export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { value, onChange, placeholder, className, readOnly = false },
  ref,
) {
  const elRef = useRef<HTMLDivElement | null>(null);
  // Track the last value we wrote to the DOM so we know when the prop change
  // is "ours" (echoed back from our onChange) vs. "theirs" (parent reset,
  // template swap, etc.). Without this every keystroke flickers the cursor.
  const lastWrittenRef = useRef<string>("");
  const [active, setActive] = useState<ToolbarActiveState>({
    bold: false,
    italic: false,
    underline: false,
  });

  // Sync `value` → DOM only when the incoming value differs from what's
  // already on screen. Compare against `innerHTML` so re-renders with the
  // same value are no-ops.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const sanitized = sanitizeLegalHtml(value || "");
    if (el.innerHTML === sanitized) return;
    el.innerHTML = sanitized;
    lastWrittenRef.current = sanitized;
  }, [value]);

  // Poll queryCommandState on every selection change while the caret lives
  // inside the editor — feeds the toolbar's active-button highlight. Skipped
  // entirely in readOnly mode since the toolbar isn't rendered.
  useEffect(() => {
    if (readOnly) return;
    const handleSelectionChange = () => {
      const el = elRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      // Bail unless the selection is actually anchored inside the editor —
      // otherwise we'd be reading state for a totally different field.
      if (!el.contains(sel.anchorNode)) return;
      try {
        setActive({
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          underline: document.queryCommandState("underline"),
        });
      } catch (err) {
        // queryCommandState can throw on detached selections in older
        // Safari — don't let a transient quirk crash the editor.
        console.warn("[nda/Editor] queryCommandState failed:", err);
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [readOnly]);

  const handleInput = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const sanitized = sanitizeLegalHtml(el.innerHTML);
    // If sanitization dropped something (e.g. user pasted a <script>) the
    // DOM and our outgoing value would drift. Re-write the DOM so they stay
    // in sync — using innerHTML keeps the caret roughly where the user was,
    // good enough for the script-paste edge case.
    if (el.innerHTML !== sanitized) {
      el.innerHTML = sanitized;
    }
    lastWrittenRef.current = sanitized;
    onChange(sanitized);
  }, [onChange]);

  useImperativeHandle(
    ref,
    () => ({
      insertHtmlAtCursor: (html: string) => {
        const el = elRef.current;
        if (!el) return;
        const safe = sanitizeLegalHtml(html);
        el.focus();
        const sel = window.getSelection();
        const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
        const caretInsideEditor =
          range && el.contains(range.commonAncestorContainer);
        if (caretInsideEditor) {
          // execCommand is deprecated but still works in every browser we
          // ship to, and it's the only path that fires `input` on Firefox.
          // See class comment above.
          document.execCommand("insertHTML", false, safe);
        } else {
          // Fallback: stick it at the end. Better UX than silently dropping
          // the click when focus has wandered.
          el.innerHTML = `${el.innerHTML}${safe}`;
        }
        // Sync our state out — execCommand fires input on most browsers but
        // not all (and the fallback above bypasses it entirely).
        handleInput();
      },
      focus: () => {
        elRef.current?.focus({ preventScroll: true });
      },
    }),
    [handleInput],
  );

  // Clicking an .nda-gap placeholder acts like clicking into an input: clear
  // its "insert a token here" stub text + position the cursor inside, so the
  // next TokenPalette click drops the token cleanly (not mixed in with the
  // placeholder string). Looked button-like in v1 but did nothing — this
  // is the actual button behavior.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (readOnly) return;
      const target = e.target as HTMLElement;
      const gap = target.closest?.(".nda-gap") as HTMLElement | null;
      if (!gap || !elRef.current?.contains(gap)) return;
      // Clear the placeholder text on first interaction. Subsequent clicks
      // (after a token's been inserted) are no-ops since textContent != the
      // canonical stub.
      const stub = "click here to insert a token";
      if (gap.textContent && gap.textContent.includes(stub)) {
        gap.textContent = "";
      }
      // Drop the cursor inside the now-empty gap so the next token insertion
      // lands in it.
      const range = document.createRange();
      range.selectNodeContents(gap);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      elRef.current?.focus({ preventScroll: true });
      handleInput();
    },
    [handleInput, readOnly],
  );

  // Show the placeholder when the editor is empty. CSS-only — we can't use
  // `::placeholder` on a contentEditable, so we paint it via a data attr +
  // `:empty::before` (defined inline below).
  const showPlaceholder = !value || value.trim() === "" || value === "<p></p>";

  // Run an execCommand, then trigger handleInput so onChange fires and the
  // active-state highlight refreshes. The arg parameter passes the block tag
  // for formatBlock (H2/H3) — undefined for inline commands.
  const runCommand = useCallback(
    (command: string, arg?: string) => {
      const el = elRef.current;
      if (!el) return;
      try {
        document.execCommand(command, false, arg);
      } catch (err) {
        console.warn(`[nda/Editor] execCommand("${command}") failed:`, err);
        return;
      }
      // execCommand fires `input` on most browsers but not always — call
      // handleInput unconditionally so onChange always sees the new HTML.
      handleInput();
    },
    [handleInput],
  );

  return (
    <div className={cn("relative w-full", className)}>
      {!readOnly && (
        <EditorToolbar active={active} runCommand={runCommand} />
      )}
      {placeholder && showPlaceholder && !readOnly && (
        <div className="absolute left-4 pointer-events-none select-none text-sm text-slate-400 top-[48px]">
          {placeholder}
        </div>
      )}
      {placeholder && showPlaceholder && readOnly && (
        <div className="absolute top-3 left-4 text-sm text-slate-400 pointer-events-none select-none">
          {placeholder}
        </div>
      )}
      <div
        ref={elRef}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        onClick={handleClick}
        className={cn(
          "legal-editor min-h-[300px] w-full border border-slate-200 bg-white",
          "px-4 py-3 text-sm leading-[1.7] text-slate-800 outline-none",
          "focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15",
          // When the toolbar's above us, drop the top corners so they meet
          // cleanly with the toolbar's rounded-top edge.
          readOnly ? "rounded-md" : "rounded-b-md border-t-0",
          readOnly && "bg-slate-50 text-slate-700 cursor-default",
        )}
        // Spell-check is more annoying than helpful for legal boilerplate.
        spellCheck={false}
      />
      {/* Render the legal-doc formatting that contentEditable would
          otherwise show flat. Scoped to .legal-editor so the rules don't
          leak into the rest of the app. */}
      <style>{`
        .legal-editor h1 { font-size: 1.5rem; font-weight: 700; margin: 1.25rem 0 0.75rem; color: #0f172a; }
        .legal-editor h2 { font-size: 1.25rem; font-weight: 700; margin: 1.1rem 0 0.6rem; color: #0f172a; }
        .legal-editor h3 { font-size: 1.05rem; font-weight: 700; margin: 1rem 0 0.5rem; color: #0f172a; }
        .legal-editor h4, .legal-editor h5, .legal-editor h6 { font-weight: 700; margin: 0.9rem 0 0.4rem; color: #0f172a; }
        .legal-editor h1.doc-title { font-size: 1.75rem; text-align: center; }
        .legal-editor h2.doc-subtitle { font-size: 1.15rem; text-align: center; color: #475569; font-weight: 500; }
        .legal-editor p { margin: 0.65rem 0; }
        .legal-editor p.doc-caption { font-size: 0.85em; color: #64748b; font-style: italic; }
        .legal-editor ul, .legal-editor ol { margin: 0.65rem 0; padding-left: 1.5rem; }
        .legal-editor ul { list-style: disc; }
        .legal-editor ol { list-style: decimal; }
        .legal-editor li { margin: 0.2rem 0; }
        .legal-editor strong, .legal-editor b { font-weight: 700; }
        .legal-editor em, .legal-editor i { font-style: italic; }
        .legal-editor u { text-decoration: underline; }
        .legal-editor s, .legal-editor strike { text-decoration: line-through; }
        .legal-editor sup { vertical-align: super; font-size: 0.75em; }
        .legal-editor sub { vertical-align: sub; font-size: 0.75em; }
        .legal-editor mark { background: #fef08a; padding: 0 0.1em; border-radius: 2px; }
        .legal-editor mark.hl-yellow { background: #fef08a; }
        .legal-editor mark.hl-green { background: #bbf7d0; }
        .legal-editor mark.hl-cyan { background: #a5f3fc; }
        .legal-editor mark.hl-magenta { background: #fbcfe8; }
        .legal-editor mark.hl-blue { background: #bfdbfe; }
        .legal-editor mark.hl-red { background: #fecaca; }
        .legal-editor mark.hl-yellow-dark { background: #fde047; }
        .legal-editor mark.hl-green-dark { background: #86efac; }
        .legal-editor blockquote { border-left: 3px solid #cbd5e1; padding-left: 0.85rem; margin: 0.85rem 0; color: #475569; font-style: italic; }
        .legal-editor blockquote.intense { border-left-color: #003366; color: #0f172a; font-style: normal; font-weight: 500; }
        .legal-editor table { border-collapse: collapse; margin: 0.85rem 0; }
        .legal-editor th, .legal-editor td { border: 1px solid #cbd5e1; padding: 0.4rem 0.6rem; }
        .legal-editor th { background: #f1f5f9; font-weight: 600; text-align: left; }
        .legal-editor hr { border: 0; border-top: 1px solid #cbd5e1; margin: 1rem 0; }
        .legal-editor a { color: #003366; text-decoration: underline; }
        .legal-editor pre, .legal-editor code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f5f9; padding: 0 0.3em; border-radius: 2px; }
        /* Clickable "fill this in" placeholder for empty paragraphs (PF-style
           gaps where the counterparty name / address / date go). Clicking
           clears the stub text + positions cursor — handled in the React
           onClick above. */
        .legal-editor p.nda-gap {
          color: #b45309;
          background: #fef3c7;
          padding: 0.35rem 0.6rem;
          border: 1px dashed #f59e0b;
          border-radius: 4px;
          text-align: center;
          font-style: italic;
          margin: 0.5rem 0;
          cursor: pointer;
          transition: background 120ms, border-color 120ms;
        }
        .legal-editor p.nda-gap:hover {
          background: #fde68a;
          border-color: #d97706;
        }
        /* Once cleared (post-click) the gap stays styled until a token is
           actually inserted, so the user can see where their cursor lives. */
        .legal-editor p.nda-gap:empty::before {
          content: "▎ pick a token from the right →";
          color: #92400e;
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
});

// ─── Toolbar ────────────────────────────────────────────────────────
// Small formatting bar above the contentEditable: B / I / U /
// H2 / H3 / bullets / numbered / clear. Each button calls
// document.execCommand which still fires `input` events in every browser
// so the parent Editor's onChange picks the change up automatically.
//
// CRITICAL: `e.preventDefault()` on `onMouseDown` keeps the editor's
// selection alive. Without it, mousedown moves focus to the button before
// execCommand runs, and the command has no selection to act on.

interface ToolbarButtonProps {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: React.ReactNode;
  /** When set, renders a chunkier monospaced label (B/I/U). */
  monoLabel?: boolean;
}

function ToolbarButton({
  onClick,
  title,
  active,
  children,
  monoLabel,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active ? "true" : "false"}
      onMouseDown={(e) => {
        // Critical — see Toolbar comment above. Without this the editor
        // loses focus before execCommand fires and the command no-ops.
        e.preventDefault();
      }}
      onClick={onClick}
      className={cn(
        "h-8 min-w-[32px] px-2 inline-flex items-center justify-center rounded text-xs font-semibold text-slate-600 transition-colors",
        "hover:bg-slate-100",
        active && "bg-slate-200 text-[#003366]",
        monoLabel && "font-serif text-[15px]",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span className="h-5 w-px bg-slate-300 mx-1" aria-hidden="true" />;
}

interface EditorToolbarProps {
  active: ToolbarActiveState;
  runCommand: (command: string, arg?: string) => void;
}

function EditorToolbar({ active, runCommand }: EditorToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 h-9 px-2 rounded-t-md border border-slate-200 bg-slate-50">
      <ToolbarButton
        title="Bold (Ctrl+B)"
        active={active.bold}
        monoLabel
        onClick={() => runCommand("bold")}
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        title="Italic (Ctrl+I)"
        active={active.italic}
        monoLabel
        onClick={() => runCommand("italic")}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        title="Underline (Ctrl+U)"
        active={active.underline}
        monoLabel
        onClick={() => runCommand("underline")}
      >
        <span className="underline">U</span>
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        title="Heading 2"
        onClick={() => runCommand("formatBlock", "h2")}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        title="Heading 3"
        onClick={() => runCommand("formatBlock", "h3")}
      >
        H3
      </ToolbarButton>
      <ToolbarButton
        title="Bullet list"
        onClick={() => runCommand("insertUnorderedList")}
      >
        • List
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        onClick={() => runCommand("insertOrderedList")}
      >
        1. List
      </ToolbarButton>
      <ToolbarDivider />
      <ToolbarButton
        title="Clear formatting"
        onClick={() => runCommand("removeFormat")}
      >
        <span className="material-symbols-outlined text-[16px]">
          format_clear
        </span>
      </ToolbarButton>
    </div>
  );
}

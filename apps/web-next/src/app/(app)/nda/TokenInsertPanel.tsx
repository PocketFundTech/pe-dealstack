"use client";

import type { RefObject } from "react";
import { cn } from "@/lib/cn";
import type { EditorHandle } from "./Editor";
import { TokenPalette } from "./TokenPalette";
import { SIGNATURE_BLOCK_MARKER, tokenLiteral } from "./constants";
import type { TokenKey } from "./types";

interface TokenInsertPanelProps {
  /** Live HTML body — drives the palette's "tokens present" checklist. */
  bodyHtml: string;
  /**
   * Ref to the document Editor. Clicking a token pill splices the
   * `[TOKEN_KEY]` literal at the caret via `insertHtmlAtCursor` — the exact
   * same marker the backend's `substituteTokens` swaps on send, so inserted
   * tokens never reach the counterparty as raw text.
   */
  editorRef: RefObject<EditorHandle | null>;
  /** Disable inserts when the editor is read-only (snapshot / preview view). */
  disabled?: boolean;
}

/**
 * Right-sidebar token panel for the per-document NDA editor (FullEditPage).
 *
 * Mirrors the palette the template verifier exposes, but scoped to a single
 * document: pick a token, it drops `[COUNTERPARTY_NAME]`-style literals into
 * the body at the caret. Without this the user could clear an `.nda-gap`
 * placeholder but had nothing to insert, so unfilled gaps shipped to the
 * counterparty as raw placeholder text.
 */
export function TokenInsertPanel({
  bodyHtml,
  editorRef,
  disabled = false,
}: TokenInsertPanelProps) {
  function handleInsert(key: TokenKey) {
    editorRef.current?.insertHtmlAtCursor(tokenLiteral(key));
  }

  const hasSignature = bodyHtml.includes(SIGNATURE_BLOCK_MARKER);

  function handleInsertSignature() {
    // Insert the marker as its own paragraph so the send pipeline can swap the
    // whole <p> for the signature block without nesting a <div> inside a <p>.
    editorRef.current?.insertHtmlAtCursor(`<p>${SIGNATURE_BLOCK_MARKER}</p>`);
  }

  return (
    <div className="pt-4 border-t border-slate-100">
      <TokenPalette
        bodyHtml={bodyHtml}
        onInsert={handleInsert}
        disabled={disabled}
        showChecklist
      />

      <div className="mt-4 pt-4 border-t border-slate-100">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-2">
          Signature
        </div>
        <p className="text-[11px] text-slate-500 leading-snug mb-3">
          Drop a signature field where the counterparty should sign. On{" "}
          <strong>Send for signature</strong> the signer&rsquo;s field lands
          here; on email it becomes a signature line. Place none and it&rsquo;s
          added at the end.
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={handleInsertSignature}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-colors",
            disabled
              ? "border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed"
              : hasSignature
                ? "border-[#003366] text-[#003366] bg-[#E6EEF5]/70 hover:bg-[#E6EEF5]"
                : "border-slate-200 text-slate-700 bg-white hover:border-[#003366] hover:text-[#003366]",
          )}
        >
          <span className="material-symbols-outlined text-[14px]">
            {hasSignature ? "check_small" : "draw"}
          </span>
          {hasSignature ? "Signature field placed" : "Insert signature field"}
        </button>
      </div>
    </div>
  );
}

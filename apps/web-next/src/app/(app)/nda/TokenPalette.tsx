"use client";

import { useMemo } from "react";
import { cn } from "@/lib/cn";
import {
  TOKEN_DESCRIPTIONS,
  TOKEN_KEYS,
  TOKEN_LABELS,
  detectTokens,
  tokenLiteral,
} from "./constants";
import type { TokenKey } from "./types";

interface TokenPaletteProps {
  /** Current HTML — used to compute the "tokens present" checklist. */
  bodyHtml: string;
  /**
   * Called when the user clicks a token pill. Implementation lives in the
   * parent so the parent can route it through the Editor ref's
   * `insertHtmlAtCursor`.
   */
  onInsert: (key: TokenKey) => void;
  /** Whether to render the bottom "tokens present" checklist. */
  showChecklist?: boolean;
  /** Disable inserts when the editor is read-only (snapshot view). */
  disabled?: boolean;
}

/**
 * Sidebar palette of insertable placeholder tokens. Click a pill → the parent
 * splices the `[TOKEN_KEY]` literal at the editor's caret. Hover a pill to
 * read the one-line description.
 */
export function TokenPalette({
  bodyHtml,
  onInsert,
  showChecklist = true,
  disabled = false,
}: TokenPaletteProps) {
  const present = useMemo(() => new Set(detectTokens(bodyHtml)), [bodyHtml]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-2">
          Insert placeholder
        </div>
        <p className="text-[11px] text-slate-500 leading-snug mb-3">
          Click a token to drop it at your cursor. The backend swaps these
          for real values when you create an NDA from this template.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {TOKEN_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onInsert(key)}
              title={TOKEN_DESCRIPTIONS[key]}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md border",
                "text-[11px] font-mono transition-colors",
                disabled
                  ? "border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed"
                  : present.has(key)
                    ? "border-[#003366] text-[#003366] bg-[#E6EEF5]/70 hover:bg-[#E6EEF5]"
                    : "border-slate-200 text-slate-700 bg-white hover:border-[#003366] hover:text-[#003366]",
              )}
            >
              <span className="material-symbols-outlined text-[12px]">
                {present.has(key) ? "check_small" : "add"}
              </span>
              {tokenLiteral(key)}
            </button>
          ))}
        </div>
      </div>

      {showChecklist && (
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-2">
            Tokens present
          </div>
          <ul className="space-y-1">
            {TOKEN_KEYS.map((key) => {
              const isPresent = present.has(key);
              return (
                <li
                  key={key}
                  className={cn(
                    "flex items-center gap-2 text-[12px]",
                    isPresent ? "text-slate-700" : "text-slate-400",
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[14px]",
                      isPresent ? "text-emerald-600" : "text-slate-300",
                    )}
                  >
                    {isPresent ? "check_circle" : "radio_button_unchecked"}
                  </span>
                  <span className="truncate">{TOKEN_LABELS[key]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

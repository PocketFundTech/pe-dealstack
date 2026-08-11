"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { Editor, type EditorHandle } from "./Editor";
import { TokenPalette } from "./TokenPalette";
import { detectTokens, tokenLiteral } from "./constants";
import type {
  CreateTemplateBody,
  LegalDocTemplate,
  ParsedTemplateDraft,
  TokenKey,
  UpdateTemplateBody,
} from "./types";

interface TemplateVerifierProps {
  /**
   * Two modes:
   *   - "create" + `draft` from the parse endpoint → POST on save
   *   - "edit" + `template` from the list → PATCH on save
   *
   * Both end up with a verified row. The verifier doesn't care which path
   * got it here; it just renders the body + lets the user mark up tokens.
   */
  mode: "create" | "edit";
  draft?: ParsedTemplateDraft;
  template?: LegalDocTemplate;
  onCancel: () => void;
  onSaved: (template: LegalDocTemplate) => void;
}

export function TemplateVerifier({
  mode,
  draft,
  template,
  onCancel,
  onSaved,
}: TemplateVerifierProps) {
  const { showToast } = useToast();
  const editorRef = useRef<EditorHandle | null>(null);

  const initialBody = mode === "create" ? draft?.bodyHtml ?? "" : template?.bodyHtml ?? "";
  const initialName =
    mode === "create" ? draft?.suggestedName ?? "" : template?.name ?? "";
  const initialDefault = mode === "edit" ? !!template?.isDefault : false;

  const [bodyHtml, setBodyHtml] = useState(initialBody);
  const [name, setName] = useState(initialName);
  const [isDefault, setIsDefault] = useState(initialDefault);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed when the input switches (e.g. user picked a different template
  // to edit without unmounting). React's useState only takes the initial
  // value the first time so a fresh effect is needed.
  useEffect(() => {
    setBodyHtml(initialBody);
    setName(initialName);
    setIsDefault(initialDefault);
    setError(null);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.bodyHtml, template?.id]);

  function handleInsert(key: TokenKey) {
    editorRef.current?.insertHtmlAtCursor(tokenLiteral(key));
  }

  const hasCounterpartyName = bodyHtml.includes(tokenLiteral("COUNTERPARTY_NAME"));
  const trimmedName = name.trim();
  const canSave = !!trimmedName && hasCounterpartyName && !submitting;

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      const placeholderKeys = detectTokens(bodyHtml);
      let saved: LegalDocTemplate;
      if (mode === "create") {
        const body: CreateTemplateBody = {
          name: trimmedName,
          docType: "NDA",
          bodyHtml,
          originalFileName: draft?.originalFileName ?? undefined,
          placeholderKeys,
          isDefault,
        };
        saved = await api.post<LegalDocTemplate>(
          "/legal-document-templates",
          body,
        );
      } else if (template) {
        const body: UpdateTemplateBody = {
          name: trimmedName,
          bodyHtml,
          placeholderKeys,
          isDefault,
          // Re-verify on every save — any edit invalidates the prior signoff
          // by default but we treat re-saving as a fresh approval.
          verifiedAt: new Date().toISOString(),
        };
        saved = await api.patch<LegalDocTemplate>(
          `/legal-document-templates/${template.id}`,
          body,
        );
      } else {
        throw new Error("Verifier mode 'edit' requires a template");
      }
      showToast(`Saved template "${saved.name}"`, "success");
      onSaved(saved);
    } catch (err) {
      console.warn("[nda] save template failed:", err);
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to save template";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-50 flex flex-col">
      {/* Header bar */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-50"
          aria-label="Back"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-slate-900 truncate">
            {mode === "create" ? "Verify new NDA template" : `Edit ${initialName || "template"}`}
          </h2>
          <p className="text-xs text-slate-500 truncate">
            Mark up the document with placeholder tokens, then save. Only
            verified templates appear in the create-NDA picker.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className={cn(
            "px-4 py-2 rounded-md text-sm font-semibold text-white inline-flex items-center gap-1.5",
            !canSave ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
          )}
          style={{ backgroundColor: "#003366" }}
        >
          {submitting && (
            <span className="material-symbols-outlined text-[16px] animate-spin">
              progress_activity
            </span>
          )}
          Save Template
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left pane — editor */}
        <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
          {error && (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm border bg-red-50 border-red-200 text-red-700 flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
              <div className="flex-1 min-w-0">{error}</div>
            </div>
          )}
          {!hasCounterpartyName && (
            <div className="mb-4 rounded-lg px-3 py-2.5 text-sm border bg-amber-50 border-amber-200 text-amber-800 flex items-start gap-2">
              <span className="material-symbols-outlined text-[18px] mt-0.5">warning</span>
              <div className="flex-1 min-w-0">
                Drop at least <span className="font-mono">[COUNTERPARTY_NAME]</span>{" "}
                into the document before saving — it&rsquo;s the one token every
                NDA needs.
              </div>
            </div>
          )}
          <div className="max-w-[820px] mx-auto bg-white shadow-sm rounded-md border border-slate-200">
            <Editor
              ref={editorRef}
              value={bodyHtml}
              onChange={setBodyHtml}
              placeholder="Template body will appear here once parsed…"
              className=""
            />
          </div>
        </div>

        {/* Right pane — palette + metadata */}
        <aside className="w-[320px] shrink-0 border-l border-slate-200 bg-white overflow-y-auto px-5 py-6">
          <div className="space-y-5">
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-semibold text-slate-500 mb-1.5">
                Template name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mutual NDA — Standard"
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-200 focus:border-[#003366] focus:ring-2 focus:ring-[#003366]/15 outline-none"
              />
              {draft?.originalFileName && (
                <p className="mt-1 text-[11px] text-slate-400 truncate">
                  Uploaded from {draft.originalFileName}
                </p>
              )}
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-[#003366] focus:ring-[#003366]/30"
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">
                  Default template
                </div>
                <div className="text-[11px] text-slate-500">
                  Pre-selected in the NDA create flow. Only one can be the
                  default at a time.
                </div>
              </div>
            </label>

            <div className="pt-2 border-t border-slate-100">
              <TokenPalette bodyHtml={bodyHtml} onInsert={handleInsert} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

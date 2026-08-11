"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/constants";
import { isGooglePickerConfigured, preloadGooglePicker } from "@/lib/googlePicker";
import { DocumentRow, DocumentAnalysisModal } from "./document-row";
import { PIPELINE_STAGES, type DocItem } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Shared types + constants live in the leaf module `deal-detail-shared.ts`
// (no components, no cycles). Re-exported here so the existing barrel
// consumers (page.tsx, deal-page-*.tsx) keep working unchanged, while the
// page's sub-components import them directly from the leaf to avoid the
// import cycle that produced the production-only React error #130.
// ---------------------------------------------------------------------------

export type {
  AssignedUser,
  DealDetail,
  DocItem,
  TeamMember,
  ChatAction,
  ChatMessage,
  Activity,
  Tab,
} from "./deal-detail-shared";
export { PIPELINE_STAGES, TERMINAL_STAGES, TABS } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Re-export layout components from deal-layout.tsx
// ---------------------------------------------------------------------------

export { StagePipeline, DealMetadataRow, FinancialMetricsRow, FinancialStatementsSection, DealViewers, FinancialStatusBadge } from "./deal-layout";
export { DealAnalysisSection } from "./deal-analysis";

// Re-export OverviewTab from deal-overview.tsx
export { OverviewTab } from "./deal-overview";
// Re-export panel components from deal-panels.tsx
export { DealActionsMenu, TeamAvatarStack, ClearChatModal } from "./deal-panels";

// ---------------------------------------------------------------------------
// Documents Tab
// ---------------------------------------------------------------------------

export function DocumentsTab({
  documents,
  uploading,
  fileInputRef,
  onUpload,
  driveImporting,
  onImportFromDrive,
}: {
  documents: DocItem[];
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  driveImporting: boolean;
  onImportFromDrive: () => void;
}) {
  // Modal state for AI-only docs (those without a backing file). Lifted here
  // so the modal renders alongside the row list and can be opened from either
  // the row click or the inline action button.
  const [analysisDoc, setAnalysisDoc] = useState<DocItem | null>(null);

  // Warm the Google Picker SDKs when this tab mounts so the "Google Drive"
  // popup opens reliably on first click (see preloadGooglePicker's docblock).
  useEffect(() => {
    if (isGooglePickerConfigured) preloadGooglePicker();
  }, []);

  const busy = uploading || driveImporting;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-main">
          Documents ({documents.length})
        </h3>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onUpload}
          />
          {isGooglePickerConfigured && (
            <button
              onClick={onImportFromDrive}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-text-secondary bg-white border border-border-subtle rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-[18px]">
                {driveImporting ? "progress_activity" : "add_to_drive"}
              </span>
              {driveImporting ? "Importing..." : "Google Drive"}
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-60"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[18px]">
              {uploading ? "progress_activity" : "upload_file"}
            </span>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border-subtle rounded-lg">
          <span className="material-symbols-outlined text-3xl text-text-muted">folder_open</span>
          <p className="mt-2 text-sm text-text-muted">No documents yet</p>
          <p className="text-xs text-text-muted mt-1">Upload files to get started</p>
        </div>
      ) : (
        <div
          className="rounded-xl divide-y divide-border-subtle"
          style={{
            background: "rgba(255, 255, 255, 0.8)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(229, 231, 235, 0.8)",
            boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
          }}
        >
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} onShowAnalysis={setAnalysisDoc} />
          ))}
        </div>
      )}

      {analysisDoc && (
        <DocumentAnalysisModal doc={analysisDoc} onClose={() => setAnalysisDoc(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-export ChatTab & ActivityTab from deal-tabs.tsx
// ---------------------------------------------------------------------------

export { ChatTab } from "./deal-tabs";
export { ActivityTab } from "./deal-tabs";

// Re-export new components (defined above)
// DealActionsMenu, TeamAvatarStack, ClearChatModal are exported inline

// ---------------------------------------------------------------------------
// Stage Change Modal
// ---------------------------------------------------------------------------

export function StageChangeModal({
  from,
  to,
  note,
  setNote,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  from: string;
  to: string;
  note: string;
  setNote: (v: string) => void;
  loading: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const fromLabel = STAGE_LABELS[from] || from;
  const toLabel = STAGE_LABELS[to] || to;
  const fromIdx = PIPELINE_STAGES.findIndex((s) => s.key === from);
  const toIdx = PIPELINE_STAGES.findIndex((s) => s.key === to);
  const isMovingBack = toIdx < fromIdx;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-md z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
        <div className="p-5 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-text-main text-base flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">swap_horiz</span>
              Change Deal Stage
            </h3>
            <button onClick={onClose} className="text-text-muted hover:text-text-main transition-colors">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
        <div className="p-5">
          <div className="flex items-center justify-center gap-4 mb-4">
            <div className="text-center">
              <div className="size-10 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-2">
                <span className="material-symbols-outlined text-gray-500">circle</span>
              </div>
              <span className="text-sm font-medium text-text-secondary">{fromLabel}</span>
            </div>
            <span
              className={cn(
                "material-symbols-outlined text-xl",
                isMovingBack ? "text-amber-500" : "text-primary"
              )}
            >
              {isMovingBack ? "arrow_back" : "arrow_forward"}
            </span>
            <div className="text-center">
              <div
                className={cn(
                  "size-10 rounded-full flex items-center justify-center mx-auto mb-2",
                  isMovingBack ? "bg-amber-100" : "bg-blue-50"
                )}
              >
                <span
                  className={cn(
                    "material-symbols-outlined",
                    isMovingBack ? "text-amber-600" : "text-primary"
                  )}
                >
                  circle
                </span>
              </div>
              <span
                className={cn(
                  "text-sm font-bold",
                  isMovingBack ? "text-amber-600" : "text-primary"
                )}
              >
                {toLabel}
              </span>
            </div>
          </div>

          {isMovingBack && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-amber-500 text-sm mt-0.5">
                  warning
                </span>
                <p className="text-sm text-amber-700">
                  You are moving this deal backwards in the pipeline. This will be logged in the
                  activity feed.
                </p>
              </div>
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-text-main mb-2">
              Add a note (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-3 py-2 border border-border-subtle rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              rows={2}
              placeholder="Reason for stage change..."
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 mb-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <span className="material-symbols-outlined text-red-500 text-sm">error</span>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-border-subtle rounded-lg font-medium text-sm hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="flex-1 px-4 py-2.5 text-white rounded-lg font-medium text-sm disabled:opacity-60 transition-colors"
              style={{ backgroundColor: "#003366" }}
            >
              {loading ? "Updating..." : "Confirm Change"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

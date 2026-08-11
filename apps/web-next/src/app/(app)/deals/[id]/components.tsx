"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { STAGE_LABELS } from "@/lib/constants";
import type { DealScorecard } from "@/types";
import { DocumentRow, DocumentAnalysisModal } from "./document-row";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssignedUser {
  id: string;
  name: string;
  avatar?: string;
  email?: string;
  title?: string;
}

export interface DealDetail {
  id: string;
  name: string;
  companyName?: string;
  stage: string;
  industry?: string;
  dealSize?: number;
  currency?: string;
  revenue?: number;
  ebitda?: number;
  irrProjected?: number;
  mom?: number;
  targetReturn?: number;
  evMultiple?: number;
  priority?: string;
  status?: string;
  aiThesis?: string;
  aiRisks?: { keyRisks?: string[]; investmentHighlights?: string[] };
  description?: string;
  assignee?: string;
  assignedUser?: AssignedUser | null;
  company?: { name?: string } | null;
  source?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  documents?: DocItem[];
  team?: TeamMember[];
  scorecard?: DealScorecard | null;
  activities?: Activity[];
}

export interface DocItem {
  id: string;
  name: string;
  type?: string;
  fileSize?: number;
  fileUrl?: string;
  aiAnalysis?: string;
  createdAt: string;
  url?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  role?: string;
}

export interface ChatAction {
  type: string;
  label: string;
  description?: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  action?: ChatAction;
  streaming?: boolean;
}

export interface Activity {
  id: string;
  type?: string;
  action: string;
  title?: string;
  description?: string;
  userName?: string;
  user?: { name?: string };
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stage pipeline config (matches the constants used in the old app)
// ---------------------------------------------------------------------------

// Matches the Deal.stage zod enum in apps/api/src/routes/deals.ts:54-56:
// INITIAL_REVIEW / DUE_DILIGENCE / IOI_SUBMITTED / LOI_SUBMITTED /
// NEGOTIATION / CLOSING / PASSED / CLOSED_WON / CLOSED_LOST.
// The visible pipeline is the 6 in-flight stages; terminal states
// (PASSED / CLOSED_WON / CLOSED_LOST) render as final and disable stage
// changes in StageChangeModal.
export const PIPELINE_STAGES = [
  { key: "INITIAL_REVIEW", label: "Initial Review", icon: "search" },
  { key: "DUE_DILIGENCE", label: "Due Diligence", icon: "fact_check" },
  { key: "IOI_SUBMITTED", label: "IOI Submitted", icon: "description" },
  { key: "LOI_SUBMITTED", label: "LOI Submitted", icon: "verified" },
  { key: "NEGOTIATION", label: "Negotiation", icon: "handshake" },
  { key: "CLOSING", label: "Closing", icon: "gavel" },
];

export const TERMINAL_STAGES = ["PASSED", "CLOSED_WON", "CLOSED_LOST"];

export const TABS = ["Overview", "Documents", "Activity"] as const;
export type Tab = (typeof TABS)[number];

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
}: {
  documents: DocItem[];
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  // Modal state for AI-only docs (those without a backing file). Lifted here
  // so the modal renders alongside the row list and can be opened from either
  // the row click or the inline action button.
  const [analysisDoc, setAnalysisDoc] = useState<DocItem | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-main">
          Documents ({documents.length})
        </h3>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
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

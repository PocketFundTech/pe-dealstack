"use client";

import type { Dispatch, SetStateAction } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { HelpSupportModal } from "@/components/layout/Header";

import {
  type DealDetail,
  type TeamMember,
  StageChangeModal,
} from "./components";
import { EditDealModal, ManageTeamModal, TerminalStageModal } from "./deal-panels";
import { PassDealModal } from "./pass-deal-modal";
import { FullscreenSectionModal } from "./fullscreen-modal";

// ---------------------------------------------------------------------------
// Stage change orchestration (open + draft note)
// ---------------------------------------------------------------------------

interface StageModalState {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// All deal-page modals — kept together so page.tsx doesn't end up with a
// 70-line block of conditional <Modal /> JSX. Each modal is mounted only when
// its open flag is truthy (the dialogs themselves don't memoize their state).
// ---------------------------------------------------------------------------

export interface DealPageModalsProps {
  deal: DealDetail;
  dealId: string;

  // Stage change
  stageModal: StageModalState | null;
  stageNote: string;
  setStageNote: Dispatch<SetStateAction<string>>;
  stageChanging: boolean;
  stageError: string;
  onConfirmStageChange: () => Promise<void>;
  onCloseStageModal: () => void;

  // Terminal stage
  showTerminalModal: boolean;
  onTerminalSelect: (stage: string) => Promise<void>;
  onCloseTerminalModal: () => void;

  // Pass context (why + when to revisit)
  showPassModal: boolean;
  passSaving: boolean;
  onConfirmPass: (input: { passReason?: string; revisitAt?: string }) => Promise<void>;
  onClosePassModal: () => void;

  // Edit deal
  showEditModal: boolean;
  onCloseEditModal: () => void;
  onDealEdited: (updated: DealDetail) => void;

  // Manage team
  showTeamModal: boolean;
  onCloseTeamModal: () => void;
  onTeamChanged: (team: TeamMember[]) => void;

  // Help & Support
  helpOpen: boolean;
  onCloseHelp: () => void;

  // Delete confirmation
  showDeleteConfirm: boolean;
  onConfirmDelete: () => Promise<void>;
  onCancelDelete: () => void;

  // Fullscreen overlay (Financials / Analysis from legacy dealFullscreen.js)
  fullscreenSection: "financials" | "analysis" | null;
  onCloseFullscreen: () => void;
}

export function DealPageModals({
  deal,
  dealId,
  stageModal,
  stageNote,
  setStageNote,
  stageChanging,
  stageError,
  onConfirmStageChange,
  onCloseStageModal,
  showTerminalModal,
  showPassModal,
  passSaving,
  onConfirmPass,
  onClosePassModal,
  onTerminalSelect,
  onCloseTerminalModal,
  showEditModal,
  onCloseEditModal,
  onDealEdited,
  showTeamModal,
  onCloseTeamModal,
  onTeamChanged,
  helpOpen,
  onCloseHelp,
  showDeleteConfirm,
  onConfirmDelete,
  onCancelDelete,
  fullscreenSection,
  onCloseFullscreen,
}: DealPageModalsProps) {
  return (
    <>
      {/* Stage Change Modal */}
      {stageModal && (
        <StageChangeModal
          from={stageModal.from}
          to={stageModal.to}
          note={stageNote}
          setNote={setStageNote}
          loading={stageChanging}
          error={stageError}
          onConfirm={onConfirmStageChange}
          onClose={onCloseStageModal}
        />
      )}

      {/* Terminal Stage Modal (Close Deal) */}
      {showTerminalModal && (
        <TerminalStageModal
          dealName={deal.name}
          onSelect={onTerminalSelect}
          onClose={onCloseTerminalModal}
        />
      )}

      {/* Pass Deal Modal — reason + revisit date */}
      {showPassModal && (
        <PassDealModal
          dealName={deal.name}
          saving={passSaving}
          onConfirm={onConfirmPass}
          onClose={onClosePassModal}
        />
      )}

      {/* Edit Deal Modal */}
      {showEditModal && (
        <EditDealModal
          deal={deal}
          onClose={onCloseEditModal}
          onSaved={onDealEdited}
        />
      )}

      {/* Manage Team Modal (header avatar stack "+") */}
      {showTeamModal && (
        <ManageTeamModal
          dealId={dealId}
          initialTeam={deal.team || []}
          onClose={onCloseTeamModal}
          onTeamChanged={onTeamChanged}
        />
      )}

      {/* Help & Support Modal (opened from user dropdown) */}
      <HelpSupportModal open={helpOpen} onClose={onCloseHelp} />

      {/* Delete Deal confirmation */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title={`Delete "${deal?.name ?? "this deal"}"?`}
        message={`This will also delete all associated data room files, documents, and team assignments. This action cannot be undone.`}
        confirmLabel="Delete Deal"
        variant="danger"
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
      />

      {/* Fullscreen overlay for Financials / Analysis (legacy dealFullscreen.js) */}
      {fullscreenSection && (
        <FullscreenSectionModal
          section={fullscreenSection}
          dealId={dealId}
          onClose={onCloseFullscreen}
        />
      )}
    </>
  );
}

export type { StageModalState };

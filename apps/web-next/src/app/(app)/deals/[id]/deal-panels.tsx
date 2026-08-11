"use client";

import { useState } from "react";
import { STAGE_LABELS } from "@/lib/constants";
import { MeetingPrepModal } from "@/components/deal-actions/MeetingPrepModal";
import { DraftEmailModal } from "@/components/deal-actions/DraftEmailModal";
import { ShareDealModal } from "@/components/deal-actions/ShareDealModal";
import type { TeamMember } from "./deal-detail-shared";

export { EditDealModal } from "./edit-deal-modal";
export { ManageTeamModal } from "./manage-team-modal";

// ---------------------------------------------------------------------------
// Deal Actions Menu (more_vert dropdown: Meeting Prep, Draft Email, Data Room, Delete)
// Ported from deal.js toggleDealActionsMenu + deal-actions-menu HTML
// ---------------------------------------------------------------------------

export function DealActionsMenu({
  dealId,
  dealName,
  onDelete,
}: {
  dealId: string;
  dealName: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showMeetingPrep, setShowMeetingPrep] = useState(false);
  const [showDraftEmail, setShowDraftEmail] = useState(false);
  const [showShare, setShowShare] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center size-9 rounded-lg border border-border-subtle bg-white hover:border-primary/30 hover:shadow-sm transition-all"
        title="More actions"
      >
        <span className="material-symbols-outlined text-[20px] text-text-muted">more_vert</span>
      </button>
      {open && (
        <>
          {/* Backdrop to close menu */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-lg shadow-lg border border-border-subtle py-1 z-50">
            <div className="px-3 py-1.5 text-[10px] font-bold text-text-muted uppercase tracking-wider">
              AI Tools
            </div>
            <button
              onClick={() => { setOpen(false); setShowMeetingPrep(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">event_note</span>
              Meeting Prep
            </button>
            <button
              onClick={() => { setOpen(false); setShowDraftEmail(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">edit_note</span>
              Draft Email
            </button>
            <button
              onClick={() => {
                setOpen(false);
                // Hand off to the /graphs page with the deal context pre-filled
                // so the Builder opens directly instead of forcing the user
                // through the DealPicker modal — they're already on this deal.
                const qs = new URLSearchParams({ dealId, dealLabel: dealName });
                window.location.href = `/graphs?${qs.toString()}`;
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">monitoring</span>
              Add a Graph
            </button>
            <button
              onClick={() => {
                setOpen(false);
                // Same handoff shape as Add a Graph — deep-links to /nda with
                // the deal context pre-filled and `create=1` so the page
                // skips the DealPicker and lands on the template-picker step.
                const qs = new URLSearchParams({
                  dealId,
                  dealLabel: dealName,
                  create: "1",
                });
                window.location.href = `/nda?${qs.toString()}`;
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">gavel</span>
              New NDA
            </button>
            <div className="border-t border-border-subtle my-1" />
            <button
              onClick={() => { setOpen(false); setShowShare(true); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">ios_share</span>
              Share Deal
            </button>
            <button
              onClick={() => {
                setOpen(false);
                window.location.href = `/data-room/${dealId}`;
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-primary-light hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">folder_open</span>
              Open Data Room
            </button>
            <div className="border-t border-border-subtle my-1" />
            <button
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              Delete Deal
            </button>
          </div>
        </>
      )}
      {showMeetingPrep && (
        <MeetingPrepModal
          dealId={dealId}
          dealName={dealName}
          onClose={() => setShowMeetingPrep(false)}
        />
      )}
      {showDraftEmail && (
        <DraftEmailModal
          dealId={dealId}
          dealName={dealName}
          onClose={() => setShowDraftEmail(false)}
        />
      )}
      {showShare && (
        <ShareDealModal
          dealId={dealId}
          dealName={dealName}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team Avatar Stack (header, matches legacy renderTeamAvatars)
// ---------------------------------------------------------------------------

export function TeamAvatarStack({
  team,
  onManage,
}: {
  team: TeamMember[];
  onManage?: () => void;
}) {
  const maxVisible = 3;
  const visible = team.slice(0, maxVisible);
  const remaining = Math.max(0, team.length - maxVisible);

  // The "+" affordance is ALWAYS rendered — clicking it opens the Manage Team
  // modal. Previously it only rendered when the team was empty (and was a dead
  // div with no onClick).
  const ManageButton = (
    <button
      type="button"
      onClick={onManage}
      title="Manage team members"
      aria-label="Manage team members"
      className="w-8 h-8 rounded-full bg-gray-100 border-2 border-white flex items-center justify-center text-gray-500 hover:bg-primary-light hover:text-primary transition-colors shrink-0"
    >
      <span className="material-symbols-outlined text-[16px]">group_add</span>
    </button>
  );

  if (team.length === 0) {
    return <div className="flex items-center">{ManageButton}</div>;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {visible.map((member, i) => {
          const initials = member.name
            ? member.name.split(" ").map((n) => n[0]).join("").substring(0, 2).toUpperCase()
            : "?";
          return (
            <div
              key={member.id || i}
              className="relative"
              style={{ zIndex: maxVisible - i }}
            >
              <div
                className="w-8 h-8 rounded-full bg-primary/10 border-2 border-white flex items-center justify-center text-primary font-semibold text-xs shadow-sm"
                title={`${member.name || "Unknown"} (${member.role || "Member"})`}
              >
                {initials}
              </div>
            </div>
          );
        })}
      </div>
      {remaining > 0 && (
        <span className="text-xs font-medium text-text-secondary bg-gray-100 px-2 py-0.5 rounded-full">
          +{remaining}
        </span>
      )}
      {ManageButton}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clear Chat Confirmation Modal (ported from deal.html #clear-chat-modal)
// ---------------------------------------------------------------------------

export function ClearChatModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" onClick={onCancel} />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs border border-red-100 overflow-hidden">
          <div className="px-6 pt-6 pb-5 text-center">
            <div className="size-10 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-3">
              <span className="material-symbols-outlined text-red-400 text-xl">delete_sweep</span>
            </div>
            <h3 className="text-[15px] font-semibold text-text-main mb-1.5">Clear Chat History?</h3>
            <p className="text-xs text-text-muted leading-relaxed">
              All messages for this deal will be permanently removed.
            </p>
          </div>
          <div className="flex gap-3 px-5 pb-5">
            <button
              onClick={onCancel}
              className="flex-1 py-2 text-sm font-medium text-text-secondary bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 py-2 text-sm font-medium text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Settings Modal (ported from deal-edit.js showContextSettings)
// ---------------------------------------------------------------------------

export function AISettingsModal({ onClose }: { onClose: () => void }) {
  const [responseStyle, setResponseStyle] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pe-ai-settings") || "{}").responseStyle || "detailed"; }
    catch { return "detailed"; }
  });
  const [includeCitations, setIncludeCitations] = useState(() => {
    try { return JSON.parse(localStorage.getItem("pe-ai-settings") || "{}").includeCitations !== false; }
    catch { return true; }
  });

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
        <div className="p-5 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-text-main text-base">AI Context Settings</h3>
            <button onClick={onClose} className="text-text-muted hover:text-text-main transition-colors">
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-text-main mb-2">AI Model</label>
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-border-subtle rounded-lg">
              <span className="material-symbols-outlined text-primary text-base">smart_toy</span>
              <span className="text-sm font-medium text-text-main">GPT-4o (ReAct Agent)</span>
              <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-green-50 text-green-600 border border-green-200">Active</span>
            </div>
            <p className="text-xs text-text-muted mt-1.5">Model is configured by your admin.</p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-text-main mb-2">Response Style</label>
            <select value={responseStyle} onChange={(e) => setResponseStyle(e.target.value)} className="w-full px-4 py-2 border border-border-subtle rounded-lg text-sm focus:border-primary focus:ring-2 focus:ring-primary/20">
              <option value="detailed">Detailed Analysis</option>
              <option value="concise">Concise Summaries</option>
              <option value="executive">Executive Briefing</option>
            </select>
          </div>
          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeCitations} onChange={(e) => setIncludeCitations(e.target.checked)} className="rounded border-gray-300 text-primary" />
              <span className="text-sm text-text-main">Include citations from documents</span>
            </label>
          </div>
          <button onClick={() => { localStorage.setItem("pe-ai-settings", JSON.stringify({ responseStyle, includeCitations })); onClose(); }} className="w-full text-white font-semibold py-2 rounded-lg transition-colors" style={{ backgroundColor: "#003366" }}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal Stage Modal (Close Deal: Won / Lost / Passed)
// Ported from deal-stages.js showTerminalStageModal
// ---------------------------------------------------------------------------

export function TerminalStageModal({
  dealName,
  onSelect,
  onClose,
}: {
  dealName: string;
  onSelect: (stage: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-md z-50 flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white/80 backdrop-blur-md rounded-xl shadow-lg max-w-md w-full border border-white/50">
        <div className="px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-text-main">Close Deal</h3>
              <p className="text-xs text-text-muted mt-0.5">{dealName}</p>
            </div>
            <button onClick={onClose} className="size-8 rounded-lg text-text-muted hover:text-text-main hover:bg-gray-100 flex items-center justify-center transition-colors">
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
          </div>
        </div>
        <div className="p-5">
          <p className="text-sm text-text-secondary mb-4">Select the final outcome:</p>
          <div className="space-y-2">
            {([
              { stage: "CLOSED_WON", icon: "check_circle", color: "emerald", label: "Closed Won", desc: "Deal successfully completed" },
              { stage: "CLOSED_LOST", icon: "cancel", color: "red", label: "Closed Lost", desc: "Deal not completed" },
              { stage: "PASSED", icon: "do_not_disturb_on", color: "gray", label: "Passed", desc: "Decided not to pursue" },
            ] as const).map(({ stage, icon, color, label, desc }) => (
              <button key={stage} onClick={() => onSelect(stage)} className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg border border-border-subtle bg-white hover:border-${color}-300 transition-all group`}>
                <div className={`size-8 rounded-lg bg-${color}-50 text-${color}-500 flex items-center justify-center group-hover:bg-${color}-500 group-hover:text-white transition-colors`}>
                  <span className="material-symbols-outlined text-lg">{icon}</span>
                </div>
                <div className="text-left flex-1">
                  <div className="font-medium text-text-main text-sm">{label}</div>
                  <div className="text-xs text-text-muted">{desc}</div>
                </div>
              </button>
            ))}
          </div>
          <button onClick={onClose} className="w-full mt-4 px-4 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Modal } from "./Modal";
import { DealOptions, UserOptions, INPUT_CLS, LABEL_CLS, BTN_PRIMARY, BTN_SECONDARY, type SharedProps } from "./form-primitives";

export function AssignDealModal({
  open,
  onClose,
  deals,
  users,
  onToast,
  prefill,
  onAssigned,
}: SharedProps & { onAssigned: () => void }) {
  const [dealId, setDealId] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"lead" | "analyst">("analyst");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setDealId("");
      setUserId("");
      setRole("analyst");
      setNotes("");
    }
  }, [open]);

  // Opened from a row (e.g. "Nudge") — start from that context.
  useEffect(() => {
    if (!open || !prefill) return;
    /* eslint-disable react-hooks/set-state-in-effect */
      if (prefill.dealId) setDealId(prefill.dealId);
      if (prefill.userId) setUserId(prefill.userId);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, prefill]);


  const submit = async () => {
    if (!dealId || !userId) {
      onToast("Please select both a deal and a team member", "error");
      return;
    }
    setSaving(true);
    try {
      // UI uses "lead" / "analyst" but the API expects LEAD / MEMBER / VIEWER.
      const apiRole = role === "lead" ? "LEAD" : "MEMBER";
      await api.post(`/deals/${dealId}/team`, { userId, role: apiRole });
      onToast("Deal assigned successfully", "success");
      onClose();
      onAssigned();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to assign deal", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Assign a deal"
      subtitle="Add someone to a deal team as lead or analyst."
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className={BTN_SECONDARY}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className={BTN_PRIMARY}
          >
            {saving ? "Assigning..." : "Assign Deal"}
          </button>
        </>
      }
    >
      <div>
        <label className={LABEL_CLS}>Select Deal</label>
        <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={INPUT_CLS}>
          <DealOptions deals={deals} />
        </select>
      </div>
      <div>
        <label className={LABEL_CLS}>Assign To</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className={INPUT_CLS}>
          <UserOptions users={users} />
        </select>
      </div>
      <div>
        <label className={LABEL_CLS}>Role</label>
        <div className="flex gap-3">
          {(["lead", "analyst"] as const).map((r) => (
            <label
              key={r}
              className={`flex-1 flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                role === r
                  ? "border-(--dash-blue) bg-(--dash-wash) text-(--dash-blue)"
                  : "border-(--dash-rule-strong) hover:border-(--dash-blue-3)"
              }`}
            >
              <input
                type="radio"
                name="role"
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
                className="accent-[#003366]"
              />
              <span className="text-sm font-medium">
                {r === "lead" ? "Lead Partner" : "Analyst"}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className={LABEL_CLS}>Notes (Optional)</label>
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any context or instructions..."
          className={`${INPUT_CLS} resize-none`}
        />
      </div>
    </Modal>
  );
}

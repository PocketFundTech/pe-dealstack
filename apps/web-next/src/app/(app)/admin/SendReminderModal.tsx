"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useNotificationCount } from "@/providers/NotificationCountProvider";
import { Modal } from "./Modal";
import { UserOptions, INPUT_CLS, LABEL_CLS, BTN_PRIMARY, BTN_SECONDARY, type SharedProps } from "./form-primitives";

export function SendReminderModal({
  open,
  onClose,
  deals,
  users,
  onToast,
  prefill,
}: SharedProps) {
  const { refresh: refreshNotifications } = useNotificationCount();
  const [userId, setUserId] = useState("");
  const [message, setMessage] = useState("");
  const [dealId, setDealId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setUserId("");
      setMessage("");
      setDealId("");
    }
  }, [open]);

  // Opened from a row (e.g. "Nudge") — start from that context.
  useEffect(() => {
    if (!open || !prefill) return;
    /* eslint-disable react-hooks/set-state-in-effect */
      if (prefill.dealId) setDealId(prefill.dealId);
      if (prefill.userId) setUserId(prefill.userId);
      if (prefill.message) setMessage(prefill.message);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, prefill]);


  const submit = async () => {
    if (!userId) {
      onToast("Please select a team member", "error");
      return;
    }
    const msg = message.trim();
    if (!msg) {
      onToast("Please enter a reminder message", "error");
      return;
    }
    setSaving(true);
    try {
      await api.post("/notifications", {
        userId,
        type: "SYSTEM",
        title: "Reminder from Admin",
        message: msg,
        dealId: dealId || undefined,
      });
      // Force-refresh the bell so a self-addressed reminder shows up
      // immediately instead of waiting for the 15s poll. No-op when the
      // recipient is someone else (their bell will catch it on next poll).
      refreshNotifications().catch(() => {
        // Polling will pick it up on the next 15s tick.
      });
      onToast("Reminder sent successfully", "success");
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to send reminder", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send a reminder"
      subtitle="Lands in their notification bell straight away."
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
            {saving ? "Sending..." : "Send Reminder"}
          </button>
        </>
      }
    >
      <div>
        <label className={LABEL_CLS}>Send To</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)} className={INPUT_CLS}>
          <UserOptions users={users} />
        </select>
      </div>
      <div>
        <label className={LABEL_CLS}>Message</label>
        <textarea
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g., Please submit the IC memo by EOD..."
          className={`${INPUT_CLS} resize-none`}
        />
      </div>
      <div>
        <label className={LABEL_CLS}>Related Deal (Optional)</label>
        <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={INPUT_CLS}>
          <option value="">No deal</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

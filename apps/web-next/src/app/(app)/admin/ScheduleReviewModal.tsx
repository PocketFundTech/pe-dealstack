"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useNotificationCount } from "@/providers/NotificationCountProvider";
import { Modal } from "./Modal";
import { DealOptions, UserOptions, INPUT_CLS, LABEL_CLS, type SharedProps } from "./form-primitives";

export function ScheduleReviewModal({
  open,
  onClose,
  deals,
  users,
  onToast,
  onScheduled,
}: SharedProps & { onScheduled: () => void }) {
  const { refresh: refreshNotifications } = useNotificationCount();
  const [title, setTitle] = useState("");
  const [dealId, setDealId] = useState("");
  const [userId, setUserId] = useState("");
  const [date, setDate] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setDate(tomorrow.toISOString().split("T")[0]);
    } else {
      setTitle("");
      setDealId("");
      setUserId("");
      setDate("");
      setPriority("MEDIUM");
      setNotes("");
    }
  }, [open]);

  const submit = async () => {
    const t = title.trim();
    if (!t) {
      onToast("Please enter a review title", "error");
      return;
    }
    if (!date) {
      onToast("Please select a review date", "error");
      return;
    }
    setSaving(true);
    try {
      // Vanilla represents reviews as tasks with a "[Review]" prefix so the
      // Upcoming Reviews card can filter them back out.
      await api.post("/tasks", {
        title: `[Review] ${t}`,
        assignedTo: userId || undefined,
        dealId: dealId || undefined,
        dueDate: date,
        priority,
        description: notes.trim() ? `Review Notes: ${notes.trim()}` : undefined,
      });
      // Refresh the bell immediately so the self-created TASK_ASSIGNED
      // notification is visible without waiting for the 15s poll.
      refreshNotifications().catch(() => {
        // Polling will catch up on the next tick.
      });
      onToast("Review scheduled successfully", "success");
      onClose();
      onScheduled();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to schedule review", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule Review"
      titleIcon={{ name: "calendar_month" }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-main hover:bg-gray-100 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Scheduling..." : "Schedule Review"}
          </button>
        </>
      }
    >
      <div>
        <label className={LABEL_CLS}>Review Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g., IC Meeting — Wagoner Industrial"
          className={INPUT_CLS}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLS}>Related Deal</label>
          <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={INPUT_CLS}>
            <DealOptions deals={deals} />
          </select>
        </div>
        <div>
          <label className={LABEL_CLS}>Review Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLS}>Reviewer</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={INPUT_CLS}>
            <UserOptions users={users} />
          </select>
        </div>
        <div>
          <label className={LABEL_CLS}>Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={INPUT_CLS}
          >
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
          </select>
        </div>
      </div>
      <div>
        <label className={LABEL_CLS}>Notes (Optional)</label>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Review agenda or prep notes..."
          className={`${INPUT_CLS} resize-none`}
        />
      </div>
    </Modal>
  );
}

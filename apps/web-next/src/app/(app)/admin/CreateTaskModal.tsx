"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useNotificationCount } from "@/providers/NotificationCountProvider";
import { Modal } from "./Modal";
import { DealOptions, UserOptions, INPUT_CLS, LABEL_CLS, BTN_PRIMARY, BTN_SECONDARY, type SharedProps } from "./form-primitives";

export function CreateTaskModal({
  open,
  onClose,
  deals,
  users,
  onToast,
  prefill,
  onCreated,
}: SharedProps & { onCreated: () => void }) {
  const { refresh: refreshNotifications } = useNotificationCount();
  const [title, setTitle] = useState("");
  const [userId, setUserId] = useState("");
  const [dealId, setDealId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setUserId("");
      setDealId("");
      setDueDate("");
      setPriority("MEDIUM");
      setDescription("");
    }
  }, [open]);

  // Opened from a row (e.g. "Nudge") — start from that context.
  useEffect(() => {
    if (!open || !prefill) return;
    /* eslint-disable react-hooks/set-state-in-effect */
      if (prefill.dealId) setDealId(prefill.dealId);
      if (prefill.userId) setUserId(prefill.userId);
      if (prefill.title) setTitle(prefill.title);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, prefill]);


  const submit = async () => {
    const t = title.trim();
    if (!t) {
      onToast("Please enter a task title", "error");
      return;
    }
    setSaving(true);
    try {
      await api.post("/tasks", {
        title: t,
        assignedTo: userId || undefined,
        dealId: dealId || undefined,
        dueDate: dueDate || undefined,
        priority,
        description: description.trim() || undefined,
      });
      // Refresh the bell immediately so the self-created TASK_ASSIGNED
      // notification is visible without waiting for the 15s poll.
      refreshNotifications().catch(() => {
        // Polling will catch up on the next tick.
      });
      onToast("Task created successfully", "success");
      onClose();
      onCreated();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Failed to create task", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a task"
      subtitle="Assign work with a due date and priority."
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
            {saving ? "Creating..." : "Create Task"}
          </button>
        </>
      }
    >
      <div>
        <label className={LABEL_CLS}>Task Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter task title..."
          className={INPUT_CLS}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLS}>Assign To</label>
          <select value={userId} onChange={(e) => setUserId(e.target.value)} className={INPUT_CLS}>
            <UserOptions users={users} />
          </select>
        </div>
        <div>
          <label className={LABEL_CLS}>Related Deal</label>
          <select value={dealId} onChange={(e) => setDealId(e.target.value)} className={INPUT_CLS}>
            <DealOptions deals={deals} />
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={LABEL_CLS}>Due Date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={INPUT_CLS}
          />
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
        <label className={LABEL_CLS}>Description (Optional)</label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add task details..."
          className={`${INPUT_CLS} resize-none`}
        />
      </div>
    </Modal>
  );
}

"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useToast } from "@/providers/ToastProvider";
import { Interaction, SCORE_CONFIG } from "./components";
import { INTERACTION_ICONS } from "./detail-panel-types";

// ─── Interaction Stats ─────────────────────────────────────

export function InteractionStats({ interactions, scoreData }: { interactions: Interaction[]; scoreData?: { score: number; label: string } }) {
  const typeCounts: Record<string, number> = { NOTE: 0, MEETING: 0, CALL: 0, EMAIL: 0, OTHER: 0 };
  for (const inter of interactions) typeCounts[inter.type] = (typeCounts[inter.type] || 0) + 1;
  const dates = interactions.map((i) => new Date(i.date || i.createdAt).getTime());
  const oldest = Math.min(...dates);
  const newest = Math.max(...dates);
  const monthSpan = Math.max(1, (newest - oldest) / (30 * 86400000));
  const avgPerMonth = (interactions.length / monthSpan).toFixed(1);

  return (
    <div className="mb-6">
      <h4 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Interaction Stats</h4>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="p-2.5 rounded-lg bg-gray-50 border border-border-subtle text-center">
          <p className="text-lg font-bold text-text-main">{interactions.length}</p>
          <p className="text-[10px] text-text-muted font-medium uppercase">Total</p>
        </div>
        <div className="p-2.5 rounded-lg bg-gray-50 border border-border-subtle text-center">
          <p className="text-lg font-bold text-text-main">~{avgPerMonth}</p>
          <p className="text-[10px] text-text-muted font-medium uppercase">Per Month</p>
        </div>
        {scoreData ? (() => {
          const sc = SCORE_CONFIG[scoreData.label] || SCORE_CONFIG.Cold;
          return (
            <div className={cn("p-2.5 rounded-lg border border-border-subtle text-center", sc.bg)}>
              <p className={cn("text-lg font-bold", sc.text)}>{scoreData.score}</p>
              <p className={cn("text-[10px] font-medium uppercase", sc.text)}>{scoreData.label}</p>
            </div>
          );
        })() : (
          <div className="p-2.5 rounded-lg bg-gray-50 border border-border-subtle text-center">
            <p className="text-lg font-bold text-text-muted">--</p>
            <p className="text-[10px] text-text-muted font-medium uppercase">Score</p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.entries(typeCounts).filter(([, c]) => c > 0).map(([type, count]) => {
          const icon = INTERACTION_ICONS[type] || INTERACTION_ICONS.OTHER;
          return (
            <span key={type} className="flex items-center gap-1 px-2 py-1 rounded-md bg-gray-50 border border-border-subtle text-[11px] text-text-secondary font-medium">
              <span className="material-symbols-outlined text-[14px]">{icon}</span> {count} {type.charAt(0) + type.slice(1).toLowerCase()}{count !== 1 ? "s" : ""}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── Add Interaction Form ──────────────────────────────────

export function AddInteractionForm({ contactId, onDone, onCancel }: { contactId: string; onDone: () => void; onCancel: () => void }) {
  const [type, setType] = useState("NOTE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { showToast } = useToast();

  async function handleSubmit() {
    if (!title.trim() && !description.trim()) {
      setFormError("Please enter a title or description.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, string> = { type };
      if (title.trim()) body.title = title.trim();
      if (description.trim()) body.description = description.trim();
      if (date) body.date = date;
      await api.post(`/contacts/${contactId}/interactions`, body);
      onDone();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to add interaction", "error");
    }
    finally { setSubmitting(false); }
  }

  const inputCls = "w-full rounded-md border border-border-subtle bg-white px-2.5 py-1.5 text-sm text-text-main focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors";

  return (
    <div className="mb-4 p-4 rounded-lg border border-primary/20 bg-blue-50/20">
      <div className="flex items-center justify-between mb-3">
        <h5 className="text-sm font-semibold text-text-main">New Interaction</h5>
        <button onClick={onCancel} className="p-1 rounded hover:bg-white text-text-muted hover:text-text-main transition-colors"><span className="material-symbols-outlined text-[16px]">close</span></button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              <option value="NOTE">Note</option><option value="MEETING">Meeting</option>
              <option value="CALL">Call</option><option value="EMAIL">Email</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Brief summary..." className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Details about this interaction..." className={cn(inputCls, "resize-none")} />
        </div>
        {formError && <p className="text-xs text-red-600">{formError}</p>}
        <button onClick={handleSubmit} disabled={submitting} className="self-end px-4 py-1.5 rounded-md text-white text-sm font-medium hover:opacity-90 transition-colors flex items-center gap-1.5 disabled:opacity-50" style={{ backgroundColor: "#003366" }}>
          <span className="material-symbols-outlined text-[16px]">save</span>{submitting ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

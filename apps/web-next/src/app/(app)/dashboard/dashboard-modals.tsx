"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/formatters";
import Link from "next/link";
import type { Task } from "./components";

// ---------------------------------------------------------------------------
// TasksModal -- "View All Tasks" modal matching legacy showTasksModal()
// ---------------------------------------------------------------------------

interface TasksModalProps {
  tasks: Task[];
  onClose: () => void;
  onToggle: (taskId: string, currentStatus: string) => void;
}

export function TasksModal({ tasks, onClose, onToggle }: TasksModalProps) {
  const PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...tasks].sort((a, b) => {
    const aDone = a.status === "COMPLETED" ? 1 : 0;
    const bDone = b.status === "COMPLETED" ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return (PRIORITY_ORDER[a.priority || ""] ?? 1) - (PRIORITY_ORDER[b.priority || ""] ?? 1);
  });

  // Lift Date.now() out of render: capture once at mount so overdue/due-today
  // checks are stable while the modal is open. (Modals close in seconds; for
  // long-lived sessions an interval refresh can be added later.)
  const [now, setNow] = useState<number>(() => Date.now());
  const todayString = new Date(now).toDateString();
  // Re-snap "now" after mount so the SSR-rendered value (frozen at build /
  // request time) is replaced with the client's actual clock. Lazy useState
  // alone can't do this without a hydration mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setNow(Date.now()); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-md z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden">
        <div className="p-6 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">check_circle</span>
            <h3 className="font-bold text-text-main text-lg">All Tasks</h3>
            <span className="text-xs bg-gray-100 text-text-muted px-2 py-0.5 rounded-full">{tasks.length}</span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-main">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {sorted.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              <span className="material-symbols-outlined text-3xl mb-2 text-secondary">task_alt</span>
              <p className="text-sm">No tasks assigned to you</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sorted.map((task) => {
                const done = task.status === "COMPLETED";
                const isOverdue = !done && task.dueDate && new Date(task.dueDate).getTime() < now;
                const isDueToday = !done && task.dueDate && new Date(task.dueDate).toDateString() === todayString;
                const dueColor = done ? "text-text-secondary" : isOverdue ? "text-red-500" : isDueToday ? "text-orange-500" : "text-text-muted";
                const dealName = task.deal?.name || task.dealName;
                const dealId = task.deal?.id || task.dealId;
                return (
                  <div key={task.id} className="p-4 border border-border-subtle rounded-lg hover:border-primary/30 transition-colors">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={done}
                        onChange={() => onToggle(task.id, task.status)}
                        className="mt-1 size-4 rounded border-gray-300 text-primary cursor-pointer"
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("font-semibold text-text-main", done && "line-through opacity-50")}>{task.title}</span>
                          {task.priority === "HIGH" && <span className="text-[10px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded font-bold">HIGH</span>}
                        </div>
                        <div className="text-xs mt-1 flex items-center gap-2">
                          <span className={dueColor}>{done ? "Completed" : task.dueDate ? formatRelativeTime(task.dueDate) : "No due date"}</span>
                          {dealName && (
                            <span className="text-text-muted">
                              &middot;{" "}
                              {dealId ? (
                                <Link href={`/deals/${dealId}`} onClick={onClose} className="hover:text-primary">{dealName}</Link>
                              ) : dealName}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignalResults -- renders AI deal signal scan results
// Matches legacy renderSignalResults() in ai-tools.js
// ---------------------------------------------------------------------------

interface SignalResultsProps {
  result: {
    signals?: Array<{
      title: string;
      description: string;
      severity: string;
      signalType: string;
      dealName: string;
      suggestedAction: string;
    }>;
    processedCount?: number;
  };
}

const SEVERITY_CONFIG: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  critical: { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", badge: "bg-red-100 text-red-700" },
  warning: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", badge: "bg-amber-100 text-amber-700" },
  info: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-700", badge: "bg-blue-100 text-blue-700" },
};

const SIGNAL_TYPE_ICONS: Record<string, string> = {
  leadership_change: "person_off",
  financial_event: "account_balance",
  market_shift: "trending_up",
  competitive_threat: "swords",
  regulatory_change: "gavel",
  growth_opportunity: "rocket_launch",
  risk_escalation: "trending_down",
  milestone_approaching: "flag",
};

export function SignalResults({ result }: SignalResultsProps) {
  if (!result.signals || result.signals.length === 0) {
    return (
      <div className="p-5 text-center">
        <span className="material-symbols-outlined text-secondary text-2xl mb-2">verified</span>
        <p className="text-sm font-medium text-text-main">All Clear</p>
        <p className="text-xs text-text-muted mt-1">No actionable signals detected across {result.processedCount || 0} deals</p>
      </div>
    );
  }

  const sorted = [...result.signals].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-bold text-text-muted uppercase tracking-wider">
          {sorted.length} Signal{sorted.length > 1 ? "s" : ""} from {result.processedCount} Deals
        </span>
      </div>
      {sorted.map((signal, i) => {
        const sc = SEVERITY_CONFIG[signal.severity] || SEVERITY_CONFIG.info;
        const typeIcon = SIGNAL_TYPE_ICONS[signal.signalType] || "notifications";
        return (
          <div key={i} className={cn("p-3 rounded-lg border transition-all hover:shadow-sm", sc.border, sc.bg)}>
            <div className="flex items-start gap-3">
              <span className={cn("material-symbols-outlined text-lg mt-0.5", sc.text)}>{typeIcon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-semibold text-text-main">{signal.title}</span>
                  <span className={cn("px-1.5 py-0.5 rounded text-[9px] font-bold uppercase", sc.badge)}>{signal.severity}</span>
                </div>
                <p className="text-xs text-text-secondary mb-1.5">{signal.dealName}: {signal.description}</p>
                <p className={cn("text-xs font-medium flex items-center gap-1", sc.text)}>
                  <span className="material-symbols-outlined text-[12px]">arrow_forward</span>
                  {signal.suggestedAction}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

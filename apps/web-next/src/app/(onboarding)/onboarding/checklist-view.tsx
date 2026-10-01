"use client";

import { cn } from "@/lib/cn";
import { CompletionFindings } from "./completion-findings";
import { TaskDef, TaskId, TASKS } from "./types";

// Checklist view — the 3-task list with progress bar. Ported from
// onboarding.html #view-checklist + renderChecklist/updateProgress
// in onboarding-flow.js.
export function ChecklistView({
  tasks = TASKS,
  completed,
  onOpenTask,
  allDone,
  onOpenWorkspace,
  onDealId,
}: {
  tasks?: TaskDef[];
  completed: Set<TaskId>;
  onOpenTask: (id: TaskId) => void;
  allDone: boolean;
  onOpenWorkspace: () => void;
  onDealId?: (id: string) => void;
}) {
  const doneCount = tasks.filter((t) => completed.has(t.id)).length;
  const pct = Math.round((doneCount / tasks.length) * 100);
  const firstIncomplete = tasks.find((t) => !completed.has(t.id));
  const left = tasks.length - doneCount;

  const heading = allDone
    ? "You're all set."
    : doneCount === 0
      ? `${tasks.length === 2 ? "Two" : "Three"} steps to your first deal.`
      : "You're making progress.";
  const sub = allDone
    ? "Your AI analyst already found things on your deal."
    : doneCount === 0
      ? "Do them in order, top to bottom. Under 3 minutes."
      : `${left} ${left === 1 ? "step" : "steps"} left. Your AI analyst is working in the background.`;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10 pb-10 overflow-y-auto">
      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-widest text-text-muted font-medium mb-2">
          Getting started · {doneCount} of {tasks.length} complete
        </div>
        <h2 className="font-display text-[32px] leading-[1.15] font-bold tracking-tight text-text-main">{heading}</h2>
        <p className="mt-2 text-[14px] text-text-secondary max-w-2xl">{sub}</p>
        <div className="mt-5 max-w-md bg-border-subtle h-[3px] rounded-sm overflow-hidden">
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: "#003366", transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
          />
        </div>
      </div>

      <div className="bg-white border border-border-subtle rounded-xl shadow-card overflow-hidden">
        <ul className="divide-y divide-border-subtle">
          {tasks.map((t, i) => {
            const isDone = completed.has(t.id);
            const isActive = !isDone && firstIncomplete?.id === t.id;
            return (
              <li
                key={t.id}
                className={cn(
                  "px-5 py-4 flex items-center gap-4 transition-colors",
                  isDone && "hover:bg-[#FAFBFC]",
                  !isDone && "hover:bg-[#FAFBFC]",
                )}
              >
                <TaskCircle index={i + 1} state={isDone ? "done" : isActive ? "active" : "pending"} />
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      "text-[14px] font-semibold text-text-main",
                      isDone && "line-through decoration-1 text-text-muted decoration-[#D1D5DB]",
                    )}
                  >
                    {t.title}
                  </div>
                  <div className={cn("text-[12.5px] text-text-secondary mt-0.5", isDone && "text-[#C5CBD3]")}>{t.subtitle}</div>
                </div>
                <span className="text-[12px] text-text-muted font-mono whitespace-nowrap">{t.time}</span>
                {isDone ? (
                  <span
                    className="material-symbols-outlined text-secondary text-[20px]"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    check_circle
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenTask(t.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-all",
                      isActive
                        ? "text-white hover:opacity-90"
                        : "bg-white text-text-secondary border border-border-subtle hover:border-border-focus hover:text-text-main",
                    )}
                    style={isActive ? { backgroundColor: "#003366" } : undefined}
                  >
                    {isActive ? "Continue" : "Start"}
                    {isActive && <span className="material-symbols-outlined text-[15px]">arrow_forward</span>}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* AI working callout */}
      <div className="mt-5 bg-primary-light/60 border border-primary/10 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "#003366" }}>
            <span
              className="material-symbols-outlined text-white text-[20px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              auto_awesome
            </span>
          </div>
          <div>
            <div className="text-[13.5px] font-semibold text-text-main flex items-center gap-2">
              Your AI analyst is already working
              <PulseDot />
            </div>
            <div className="text-[12.5px] text-text-secondary mt-0.5">
              Findings stream into Home as they&apos;re discovered — no need to wait.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenWorkspace}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-white px-[13px] py-[7px] text-[13px] font-medium text-text-secondary hover:border-border-focus hover:text-text-main transition-colors flex-shrink-0"
        >
          Go to Home
        </button>
      </div>

      {/* Completion CTA — dynamically populated with real findings */}
      {allDone && (
        <div className="mt-6 bg-white border-2 border-secondary/30 rounded-xl p-6 animate-[fadeIn_320ms_ease_both]">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-secondary font-semibold mb-3">
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
            You&apos;re in
          </div>

          <CompletionFindings onDealId={onDealId} />

          <div className="mt-5 pt-5 border-t border-border-subtle flex items-center justify-between gap-4 flex-wrap">
            <div className="text-[12.5px] text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">info</span>
              Every finding traces to a page + cell in the source document.
            </div>
            <button
              type="button"
              onClick={onOpenWorkspace}
              className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-white font-semibold text-sm transition-all hover:opacity-90"
              style={{ backgroundColor: "#003366" }}
            >
              Open your deal
              <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function TaskCircle({ index, state }: { index: number; state: "pending" | "active" | "done" }) {
  if (state === "done") {
    return (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-secondary text-white text-[13px]">
        <span
          className="material-symbols-outlined text-[18px]"
          style={{ fontVariationSettings: "'FILL' 1, 'wght' 600" }}
        >
          check
        </span>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className="inline-flex size-7 items-center justify-center rounded-full text-white text-[13px] font-semibold"
        style={{ backgroundColor: "#003366", boxShadow: "0 0 0 4px rgba(0,51,102,0.12)" }}
      >
        {index}
      </span>
    );
  }
  return (
    <span className="inline-flex size-7 items-center justify-center rounded-full bg-gray-100 border border-border-subtle text-[13px] font-semibold text-gray-500">
      {index}
    </span>
  );
}

function PulseDot() {
  return <span className="pulse-dot inline-block flex-shrink-0" />
}

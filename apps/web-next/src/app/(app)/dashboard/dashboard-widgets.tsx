"use client";

// Inline core-widget JSX extracted from page.tsx. These are the three biggest
// blocks that lived inside the dashboard page render: Active Priorities table,
// My Tasks list, and AI Deal Signals scanner. Pulled out so page.tsx can stay
// under the 500-line cap. Behavior is unchanged — props mirror the closure
// state the page already had on hand.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { formatCurrency, formatRelativeTime } from "@/lib/formatters";
import { STAGE_STYLES, STAGE_LABELS } from "@/lib/constants";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { useState } from "react";
import { Deal, Task, fmtNextAction } from "./components";
import { InboxDealsModal, type InboxDealCandidate } from "./widgets/inbox-deals-modal";
import { SignalResults } from "./dashboard-modals";
import {
  ScanTerminal,
  ScanProcessSummary,
  formatScanEvent,
  type ScanEvent,
  type TerminalLine,
} from "./widgets/scan-terminal";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Active Priorities widget                                               */
/* ──────────────────────────────────────────────────────────────────────── */

interface ActivePrioritiesWidgetProps {
  deals: Deal[];
  loading: boolean;
}

export function ActivePrioritiesWidget({ deals, loading }: ActivePrioritiesWidgetProps) {
  const router = useRouter();
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-surface-card shadow-card overflow-hidden group">
      <div className="p-5 border-b border-border-subtle flex items-center justify-between bg-white">
        <h3 className="font-bold text-text-main text-base">Active Priorities</h3>
        <div className="flex gap-2">
          <Link href="/deals" className="text-xs font-semibold text-text-secondary hover:text-primary hover:bg-primary-light px-3 py-1.5 rounded-md border border-transparent hover:border-primary/20 transition-all">View All</Link>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-text-secondary">
          <thead className="bg-gray-50 text-xs uppercase font-semibold text-text-secondary border-b border-border-subtle">
            <tr>
              <th className="px-5 py-3 tracking-wide">Deal Name</th>
              <th className="px-5 py-3 tracking-wide">Stage</th>
              <th className="px-5 py-3 tracking-wide">Value</th>
              <th className="px-5 py-3 tracking-wide">Next Action</th>
              <th className="px-5 py-3 tracking-wide">Team</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle bg-white">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-5 py-4">
                    <div className="flex flex-col gap-1.5">
                      <Skeleton.Line width="65%" height={14} />
                      <Skeleton.Line width="40%" height={11} />
                    </div>
                  </td>
                  <td className="px-5 py-4"><Skeleton.Badge width={88} /></td>
                  <td className="px-5 py-4"><Skeleton.Line width="60%" height={14} /></td>
                  <td className="px-5 py-4"><Skeleton.Line width="80%" height={13} /></td>
                  <td className="px-5 py-4">
                    <div className="flex items-center -space-x-1.5">
                      <Skeleton.Circle size={28} />
                      <Skeleton.Circle size={28} />
                    </div>
                  </td>
                </tr>
              ))
            ) : deals.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-10 text-center">
                <span className="material-symbols-outlined text-text-muted text-[32px] mb-2 block opacity-60">priority_high</span>
                <p className="text-sm font-medium text-text-main">No active priorities</p>
                <p className="text-xs text-text-muted mt-1">Deals needing immediate attention will appear here</p>
              </td></tr>
            ) : deals.map((deal) => {
              const style = STAGE_STYLES[deal.stage] || STAGE_STYLES.INITIAL_REVIEW;
              const members: Array<{ name?: string; email?: string }> = [];
              if (deal.assignedUser) members.push(deal.assignedUser);
              if (deal.teamMembers) {
                deal.teamMembers.forEach((tm) => { if (tm.user) members.push(tm.user); });
              }
              return (
                <tr key={deal.id} onClick={() => router.push(`/deals/${deal.id}`)} className="hover:bg-gray-50 transition-colors cursor-pointer group">
                  <td className="px-5 py-4">
                    <div className="font-semibold text-text-main">{deal.name}</div>
                    <div className="text-xs text-text-muted">{deal.industry || ""}</div>
                  </td>
                  <td className="px-5 py-4">
                    <span className={cn("inline-flex items-center rounded-md border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap", style.bg, style.text, style.border)}>
                      {STAGE_LABELS[deal.stage] || deal.stage}
                    </span>
                  </td>
                  <td className="px-5 py-4 font-mono font-semibold text-text-main">{deal.dealSize != null ? formatCurrency(deal.dealSize, deal.currency) : "—"}</td>
                  <td className="px-5 py-4 text-text-secondary">{deal.nextAction || fmtNextAction(deal.stage)}</td>
                  <td className="px-5 py-4">
                    <div className="flex items-center">
                      {members.length === 0 ? (
                        <span className="text-xs text-text-muted">Unassigned</span>
                      ) : members.slice(0, 3).map((m, mi) => (
                        <div key={mi} className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold text-white border-2 border-white" style={{ backgroundColor: "#003366", marginLeft: mi === 0 ? 0 : "-6px" }} title={m.name || m.email || ""}>
                          {(m.name || m.email || "?").charAt(0).toUpperCase()}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  My Tasks widget                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

interface MyTasksWidgetProps {
  tasks: Task[];
  pendingTasks: Task[];
  loading: boolean;
  taskError: string | null;
  onToggleTask: (taskId: string, currentStatus: string) => void;
  onOpenAllTasks: () => void;
}

export function MyTasksWidget({
  tasks,
  pendingTasks,
  loading,
  taskError,
  onToggleTask,
  onOpenAllTasks,
}: MyTasksWidgetProps) {
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-surface-card shadow-card overflow-hidden group">
      <div className="p-5 border-b border-border-subtle flex items-center justify-between bg-white">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-text-secondary">check_circle</span>
          <h3 className="font-bold text-text-main text-base">My Tasks</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-primary-light text-primary text-xs font-bold px-2.5 py-1 rounded-full border border-primary/10">{pendingTasks.length} Pending</span>
        </div>
      </div>
      {taskError && (
        <div className="px-5 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {taskError}
        </div>
      )}
      <div>
        {loading ? (
          <div className="flex flex-col">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={cn("flex items-start gap-3 p-4", i < 3 && "border-b border-border-subtle/50")}>
                <Skeleton width={16} height={16} rounded="sm" className="mt-1" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <Skeleton.Line width={`${75 - i * 5}%`} height={13} />
                  <Skeleton.Line width="50%" height={11} />
                </div>
              </div>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-muted">
            <span className="material-symbols-outlined text-3xl mb-2 text-secondary">task_alt</span>
            <span className="text-sm font-medium">All caught up!</span>
            <span className="text-xs mt-0.5">No tasks assigned to you</span>
          </div>
        ) : tasks.slice(0, 5).map((task, i) => {
          const done = task.status === "COMPLETED";
          const isOverdue = !done && task.dueDate && formatRelativeTime(task.dueDate).toLowerCase().includes("ago");
          const isDueToday = !done && task.dueDate && (() => { const d = new Date(task.dueDate!); const n = new Date(); return d.toDateString() === n.toDateString(); })();
          const dueColor = done ? "text-text-secondary" : isOverdue ? "text-red-500" : isDueToday ? "text-orange-500" : "text-text-muted";
          const dealName = task.deal?.name || task.dealName;
          return (
            <label key={task.id} className={cn("flex items-start gap-3 p-4 hover:bg-gray-50 transition-colors cursor-pointer group", i < Math.min(tasks.length, 5) - 1 && "border-b border-border-subtle/50")}>
              <input type="checkbox" checked={done} onChange={() => onToggleTask(task.id, task.status)} className="mt-1 size-4 rounded border-gray-300 text-primary focus:ring-primary focus:ring-offset-0" />
              <div className={cn("flex flex-col gap-0.5 flex-1", done && "opacity-50")}>
                <div className="flex items-center gap-2">
                  <span className={cn("text-sm text-text-main group-hover:text-primary transition-colors", done ? "font-medium line-through" : "font-semibold")}>{task.title}</span>
                  {!done && task.priority === "HIGH" && <span className="text-[10px] bg-red-50 text-red-500 px-1.5 py-0.5 rounded font-bold">HIGH</span>}
                  {!done && task.priority === "LOW" && <span className="text-[10px] bg-gray-100 text-text-muted px-1.5 py-0.5 rounded font-bold">LOW</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("text-xs font-medium", dueColor)}>
                    {done ? "Completed" : task.dueDate ? formatRelativeTime(task.dueDate) : "No due date"}
                  </span>
                  {dealName && <span className="text-xs text-text-muted">· {dealName}</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <div className="p-3 bg-gray-50 text-center border-t border-border-subtle">
        <button onClick={onOpenAllTasks} className="text-xs font-bold text-primary hover:text-primary-hover transition-colors uppercase tracking-wide">View All Tasks</button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  AI Deal Signals widget                                                 */
/*                                                                          */
/*  Repurposed: this prominent widget now runs the Gmail inbox deal scan    */
/*  (POST /ai/scan-inbox) and surfaces new-deal candidates via the shared   */
/*  InboxDealsModal (review-first — a Deal is created only when the user    */
/*  clicks "Create deal"). The portfolio-signals scanner (/ai/scan-signals) */
/*  is intentionally left in place on the backend; only this widget's       */
/*  wiring changed.                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

// Returned by POST /ai/scan-inbox. `candidates` carries the same shape the
// InboxDealsModal renders, so the type is imported (not redefined) from there.
export type InboxScanResult = {
  connected: boolean;
  scanned: number;
  candidates: InboxDealCandidate[];
  attachmentsUnread?: number;
  // How the scan triaged the inbox — surfaced as a one-line "what the scan did"
  // summary so the pickup process is visible, not a black box.
  process?: {
    scanned: number;
    skippedLowSignal: number;
    high: number;
    medium: number;
    low: number;
  };
};

const INBOX_LOOKBACK_DAYS = 14;

interface AiDealSignalsWidgetProps {
  scanning: boolean;
  signalResult: InboxScanResult | null;
  signalError: string | null;
  setScanning: (v: boolean) => void;
  setSignalResult: (v: InboxScanResult | null) => void;
  setSignalError: (v: string | null) => void;
}

export function AiDealSignalsWidget({
  scanning,
  signalResult,
  signalError,
  setScanning,
  setSignalResult,
  setSignalError,
}: AiDealSignalsWidgetProps) {
  const candidates = signalResult?.connected ? signalResult.candidates : [];
  // The review overlay is opened explicitly (and auto-opened right after a fresh
  // scan). Closing it no longer discards `signalResult`, so the found candidates
  // persist in the widget body and can be reopened without re-scanning.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Live terminal log — one line per streamed scan event. Cleared on each new
  // scan, kept visible afterwards so the user can read what was picked up.
  const [logLines, setLogLines] = useState<TerminalLine[]>([]);

  const runScan = async () => {
    setScanning(true);
    setSignalResult(null);
    setSignalError(null);
    setLogLines([]);
    const append = (line: TerminalLine) => setLogLines((prev) => [...prev, line]);
    try {
      await api.postStream(
        "/ai/scan-inbox/stream",
        { lookbackDays: INBOX_LOOKBACK_DAYS },
        (obj) => {
          const ev = obj as ScanEvent;
          if (ev.t === "result") {
            const result = ev.result as InboxScanResult;
            setSignalResult(result);
            append({
              kind: "done",
              text: `Done — ${result.candidates.length} candidate${result.candidates.length === 1 ? "" : "s"} to review`,
            });
            setReviewOpen(result.connected && result.candidates.length > 0);
            return;
          }
          if (ev.t === "error") {
            setSignalError(ev.msg);
          }
          const line = formatScanEvent(ev);
          if (line) append(line);
        },
      );
    } catch (err) {
      console.warn("[dashboard] scan-inbox stream failed:", err);
      setSignalError("Couldn't scan inbox — please try again.");
      setTimeout(() => setSignalError(null), 5000);
    } finally {
      setScanning(false);
    }
  };

  // Create/Dismiss in the modal lifts the change back to the parent's persisted
  // signalResult so the count, the widget body, and localStorage stay in sync
  // (and a dismissed card doesn't reappear on the next render).
  const removeCandidate = (emailId: string) => {
    if (!signalResult) return;
    setSignalResult({
      ...signalResult,
      candidates: signalResult.candidates.filter((c) => c.emailId !== emailId),
    });
  };

  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-surface-card shadow-card overflow-hidden group">
      <div className="p-5 border-b border-border-subtle flex items-center justify-between bg-white">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">forward_to_inbox</span>
          <h3 className="font-bold text-text-main text-base">Inbox Deal Finder</h3>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span className={cn("material-symbols-outlined text-[16px]", scanning && "animate-spin")}>{scanning ? "progress_activity" : "forward_to_inbox"}</span>
          {scanning ? "Scanning..." : "Scan inbox"}
        </button>
      </div>
      {signalError && (
        <div className="px-5 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100 flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {signalError}
        </div>
      )}
      {/* Live terminal — shows while scanning and stays up afterwards so the
          picked-up mail is auditable. */}
      {(scanning || logLines.length > 0) && (
        <ScanTerminal lines={logLines} scanning={scanning} />
      )}
      {scanning ? null : signalResult && !signalResult.connected ? (
        <div className="p-5 text-center">
          <span className="material-symbols-outlined text-text-muted text-2xl mb-2">link_off</span>
          <p className="text-sm font-medium text-text-main mb-1">Connect Gmail to scan</p>
          <p className="text-xs text-text-muted">
            Connect Gmail in{" "}
            <Link href="/settings" className="font-medium text-primary hover:text-primary-hover">
              Settings
            </Link>{" "}
            &rarr; Integrations to scan your inbox for new deal candidates.
          </p>
        </div>
      ) : candidates.length > 0 ? (
        <div className="flex flex-col items-center gap-3 p-5 text-center">
          <span className="material-symbols-outlined text-primary text-2xl">forward_to_inbox</span>
          <div>
            <p className="text-sm font-medium text-text-main mb-1">
              {candidates.length} deal candidate{candidates.length === 1 ? "" : "s"} found
            </p>
            <p className="text-xs text-text-muted">
              Review to create deals, or scan again for newer emails.
            </p>
          </div>
          {signalResult?.process && (
            <ScanProcessSummary process={signalResult.process} />
          )}
          <button
            type="button"
            onClick={() => setReviewOpen(true)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-all"
            style={{ backgroundColor: "#003366" }}
          >
            <span className="material-symbols-outlined text-[16px]">rate_review</span>
            Review {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
          </button>
        </div>
      ) : signalResult && candidates.length === 0 ? (
        <div className="p-5 text-center">
          <span className="material-symbols-outlined text-text-muted text-2xl mb-2">mark_email_read</span>
          <p className="text-sm font-medium text-text-main mb-1">No new deals found</p>
          <p className="text-xs text-text-muted">No new deal candidates turned up in your recent inbox.</p>
        </div>
      ) : (
        <div className="p-5 text-center">
          <span className="material-symbols-outlined text-text-muted text-2xl mb-2">forward_to_inbox</span>
          <p className="text-sm font-medium text-text-main mb-1">Inbox Deal Finder</p>
          <p className="text-xs text-text-muted">Click &quot;Scan inbox&quot; to scan your inbox for new deal candidates and create them in one click.</p>
        </div>
      )}
      {reviewOpen && (
        <InboxDealsModal
          candidates={candidates}
          attachmentsUnread={signalResult?.attachmentsUnread ?? 0}
          onClose={() => setReviewOpen(false)}
          onRemove={removeCandidate}
        />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Portfolio Signal Monitor widget                                         */
/*                                                                          */
/*  Optional (off by default) dashboard widget that re-homes the            */
/*  portfolio-signals feature. Calls GET /ai/scan-signals and renders the   */
/*  results via the shared SignalResults component. This is distinct from   */
/*  the AiDealSignalsWidget above, which is now the Gmail inbox deal        */
/*  finder. Self-contained: owns its own scanning/result/error state.       */
/* ──────────────────────────────────────────────────────────────────────── */

// Returned by GET /ai/scan-signals — mirrors the shape SignalResults renders.
type PortfolioSignalsResult = {
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

export function PortfolioSignalsWidget() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<PortfolioSignalsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col rounded-lg border border-border-subtle bg-surface-card shadow-card overflow-hidden group">
      <div className="p-5 border-b border-border-subtle flex items-center justify-between bg-white">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-[20px]">radar</span>
          <h3 className="font-bold text-text-main text-base">Portfolio Signal Monitor</h3>
        </div>
        <button
          onClick={async () => {
            setScanning(true);
            setResult(null);
            setError(null);
            try {
              const res = await api.get<PortfolioSignalsResult>("/ai/scan-signals");
              setResult(res);
            } catch (err) {
              console.warn("[dashboard] scan-signals failed:", err);
              setError("Couldn't scan portfolio signals — please try again.");
              setTimeout(() => setError(null), 5000);
            } finally {
              setScanning(false);
            }
          }}
          disabled={scanning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all disabled:opacity-60"
          style={{ backgroundColor: "#003366" }}
        >
          <span className={cn("material-symbols-outlined text-[16px]", scanning && "animate-spin")}>{scanning ? "progress_activity" : "radar"}</span>
          {scanning ? "Scanning..." : "Scan signals"}
        </button>
      </div>
      {error && (
        <div className="px-5 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100 flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </div>
      )}
      {scanning ? (
        <div className="flex flex-col items-center justify-center py-8">
          <span className="material-symbols-outlined text-primary text-2xl animate-spin mb-2">radar</span>
          <p className="text-sm text-text-muted">Scanning your portfolio for actionable signals...</p>
        </div>
      ) : result ? (
        <SignalResults result={result} />
      ) : (
        <div className="p-5 text-center">
          <span className="material-symbols-outlined text-text-muted text-2xl mb-2">radar</span>
          <p className="text-sm font-medium text-text-main mb-1">Portfolio Signal Monitor</p>
          <p className="text-xs text-text-muted">Click &quot;Scan signals&quot; to surface AI-detected signals across your active deals.</p>
        </div>
      )}
    </div>
  );
}

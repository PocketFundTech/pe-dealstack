"use client";

// Inline core-widget JSX extracted from page.tsx. These are the three biggest
// blocks that lived inside the dashboard page render: Active Priorities table,
// My Tasks list, and AI Deal Signals scanner. Pulled out so page.tsx can stay
// under the 500-line cap. Behavior is unchanged — props mirror the closure
// state the page already had on hand.

import Link from "next/link";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useState } from "react";
import { WidgetShell } from "./widgets/shell";
import { InboxDealsModal, type InboxDealCandidate } from "./widgets/inbox-deals-modal";
import {
  ScanTerminal,
  ScanProcessSummary,
  formatScanEvent,
  type ScanEvent,
  type TerminalLine,
} from "./widgets/scan-terminal";

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
    <WidgetShell
      title="Inbox Deal Finder"
      headerRight={
        <button
          type="button"
          onClick={runScan}
          disabled={scanning}
          className="dash-btn-ghost shrink-0 whitespace-nowrap flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60"
        >
          <span className={cn("material-symbols-outlined text-[16px]", scanning && "animate-spin")}>{scanning ? "progress_activity" : "forward_to_inbox"}</span>
          {scanning ? "Scanning…" : "Scan inbox"}
        </button>
      }
    >
      {signalError && (
        <p className="px-5 py-2 text-xs text-(--dash-red) bg-(--dash-red-wash) border-b border-(--dash-rule) flex items-center gap-2">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {signalError}
        </p>
      )}
      {/* Live terminal — shows while scanning and stays up afterwards so the
          picked-up mail is auditable. */}
      {(scanning || logLines.length > 0) && (
        <ScanTerminal lines={logLines} scanning={scanning} />
      )}
      {scanning ? null : signalResult && !signalResult.connected ? (
        <div className="px-5 py-5 text-sm text-(--dash-ink-2)">
          <p className="font-semibold text-(--dash-ink) mb-1">Gmail isn&apos;t connected</p>
          <p>
            Connect it in{" "}
            <Link href="/settings" className="dash-link">Settings → Integrations</Link>{" "}
            to find new deal candidates in your inbox.
          </p>
        </div>
      ) : candidates.length > 0 ? (
        <div className="flex flex-col gap-3 px-5 py-5">
          <p className="text-sm text-(--dash-ink-2)">
            <span className="dash-figure text-3xl text-(--dash-ink) mr-2 align-[-2px]">{candidates.length}</span>
            deal candidate{candidates.length === 1 ? "" : "s"} waiting for review
          </p>
          {signalResult?.process && (
            <ScanProcessSummary process={signalResult.process} />
          )}
          <button
            type="button"
            onClick={() => setReviewOpen(true)}
            className="dash-btn-primary self-start flex items-center gap-1.5 rounded-md px-3.5 py-2 text-xs font-semibold transition-colors"
          >
            Review candidates
          </button>
        </div>
      ) : signalResult && candidates.length === 0 ? (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2)">
          No new deals in the last {INBOX_LOOKBACK_DAYS} days of email. Scan again after new outreach arrives.
        </p>
      ) : (
        <p className="px-5 py-5 text-sm text-(--dash-ink-2) max-w-[52ch]">
          Reads the last {INBOX_LOOKBACK_DAYS} days of your Gmail for potential deals. You review every candidate before anything is created.
        </p>
      )}
      {reviewOpen && (
        <InboxDealsModal
          candidates={candidates}
          attachmentsUnread={signalResult?.attachmentsUnread ?? 0}
          onClose={() => setReviewOpen(false)}
          onRemove={removeCandidate}
        />
      )}
    </WidgetShell>
  );
}

// Portfolio Signal Monitor lives in its own module; re-exported so the
// registry and existing imports keep working.
export { PortfolioSignalsWidget } from "./widgets/portfolio-signals";

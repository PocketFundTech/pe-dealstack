"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

// Live "terminal" for the inbox deal scan. The backend streams NDJSON progress
// events (see POST /api/ai/scan-inbox/stream); the widget maps each one to a
// TerminalLine and renders them here so the user watches exactly which mail is
// listed, scored, gated, extracted, and surfaced in real time.

// Mirrors the backend `ScanEvent` union (inboxDealScanService.ts). `result` is
// left as `unknown` so this module doesn't depend on the widget's result type
// (avoids a circular import) — the widget narrows it.
export type ScanEvent =
  | { t: "status"; msg: string }
  | { t: "listed"; count: number; lookbackDays: number }
  | { t: "email"; subject: string; from: string; score: number; priority: string; gated: boolean; signals: string[] }
  | { t: "extract"; subject: string }
  | { t: "candidate"; company: string; priority: string; confidence: number }
  | { t: "skip"; subject: string; reason: string }
  | { t: "result"; result: unknown }
  | { t: "error"; msg: string };

export type TerminalLineKind =
  | "status" | "listed" | "email" | "gated" | "extract" | "candidate" | "skip" | "done" | "error";

export interface TerminalLine {
  kind: TerminalLineKind;
  text: string;
}

const KIND_STYLE: Record<TerminalLineKind, { color: string; glyph: string }> = {
  status: { color: "text-slate-400", glyph: "›" },
  listed: { color: "text-cyan-300", glyph: "⬇" },
  email: { color: "text-slate-200", glyph: "•" },
  gated: { color: "text-amber-400", glyph: "⤫" },
  extract: { color: "text-sky-300", glyph: "⋯" },
  candidate: { color: "text-emerald-400", glyph: "✓" },
  skip: { color: "text-slate-500", glyph: "✗" },
  done: { color: "text-emerald-300 font-bold", glyph: "■" },
  error: { color: "text-red-400", glyph: "✗" },
};

// Trim a "Name <email>" From header down to something short for a log line.
function shortFrom(from: string): string {
  const m = from.match(/<([^>]+)>/);
  const who = (m ? m[1] : from).trim();
  return who.length > 34 ? who.slice(0, 33) + "…" : who;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Map a streamed ScanEvent to a terminal line. Returns null for events the
 * widget handles itself (`result` closes the run; `error` is surfaced as a
 * banner too) — callers may still render error lines separately.
 */
export function formatScanEvent(ev: ScanEvent): TerminalLine | null {
  switch (ev.t) {
    case "status":
      return { kind: "status", text: ev.msg };
    case "listed":
      return {
        kind: "listed",
        text: `Found ${ev.count} email${ev.count === 1 ? "" : "s"} in the last ${ev.lookbackDays} days`,
      };
    case "email":
      return {
        kind: ev.gated ? "gated" : "email",
        text: `[${ev.score} ${ev.priority}]${ev.gated ? " skip" : ""} ${clip(ev.subject, 52)} — ${shortFrom(ev.from)}`,
      };
    case "extract":
      return { kind: "extract", text: `extracting: ${clip(ev.subject, 60)}` };
    case "candidate":
      return { kind: "candidate", text: `${clip(ev.company, 40)}  [${ev.priority}]  ${ev.confidence}% confidence` };
    case "skip":
      return { kind: "skip", text: `${clip(ev.subject, 46)} — ${ev.reason}` };
    case "error":
      return { kind: "error", text: ev.msg };
    case "result":
      return null;
  }
}

export interface ScanProcess {
  scanned: number;
  skippedLowSignal: number;
  high: number;
  medium: number;
  low: number;
}

// Compact "what the scan did" line: how the inbox was triaged into priority
// tiers, and how many low-signal emails were filtered out before the LLM.
export function ScanProcessSummary({ process }: { process: ScanProcess }) {
  const tiers: Array<{ label: string; count: number; className: string }> = [
    { label: "High", count: process.high, className: "bg-green-50 text-green-700" },
    { label: "Med", count: process.medium, className: "bg-amber-50 text-amber-700" },
    { label: "Low", count: process.low, className: "bg-gray-100 text-text-muted" },
  ].filter((t) => t.count > 0);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {tiers.map((t) => (
          <span
            key={t.label}
            className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", t.className)}
          >
            {t.count} {t.label}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-text-muted">
        Scanned {process.scanned} email{process.scanned === 1 ? "" : "s"}
        {process.skippedLowSignal > 0 && <> · {process.skippedLowSignal} skipped as low-signal</>}
      </p>
    </div>
  );
}

export function ScanTerminal({ lines, scanning }: { lines: TerminalLine[]; scanning: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the newest line as the stream arrives.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  return (
    <div className="mx-4 mb-4 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-inner">
      <div className="flex items-center gap-1.5 border-b border-slate-700 bg-slate-800 px-3 py-1.5">
        <span className="size-2 rounded-full bg-red-400/70" />
        <span className="size-2 rounded-full bg-amber-400/70" />
        <span className="size-2 rounded-full bg-emerald-400/70" />
        <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-slate-400">
          inbox scan
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {lines.map((line, i) => {
          const s = KIND_STYLE[line.kind];
          return (
            <div key={i} className={cn("flex gap-1.5 whitespace-pre-wrap break-words", s.color)}>
              <span className="select-none opacity-70">{s.glyph}</span>
              <span>{line.text}</span>
            </div>
          );
        })}
        {scanning && (
          <div className="flex gap-1.5 text-slate-500">
            <span className="animate-pulse">▊</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

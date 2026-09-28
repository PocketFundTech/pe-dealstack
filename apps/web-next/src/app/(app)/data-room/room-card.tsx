"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Skeleton";
import { stageLabel, stageStep, STAGE_STEP_COUNT } from "../dashboard/components";
import { dayOffset, touchLabel } from "../dashboard/triage";
import { isPassed, roomIndustry, roomName, type RoomDeal, type RoomStatus } from "./room-status";

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "picture_as_pdf";
  if (["xlsx", "xls", "csv", "xlsm"].includes(ext)) return "table_chart";
  if (["doc", "docx"].includes(ext)) return "article";
  if (["ppt", "pptx"].includes(ext)) return "slideshow";
  return "draft";
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "brass" | "blue" }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.6875rem] font-medium",
      tone === "brass" ? "bg-(--dash-brass-wash) text-(--dash-brass)" : tone === "blue" ? "bg-(--dash-wash) text-(--dash-blue)" : "bg-(--dash-paper) text-(--dash-ink-2)",
    )}>
      {children}
    </span>
  );
}

interface Props {
  deal: RoomDeal;
  status?: RoomStatus;
  failed: boolean;
  showCreated: boolean;
  now: number;
  onRetry: () => void;
}

export function RoomCard({ deal, status, failed, showCreated, now, onRetry }: Props) {
  const name = roomName(deal);
  const industry = roomIndustry(deal);
  const step = stageStep(deal.stage || "");
  const passed = isPassed(deal);
  const lastDoc = deal.lastDocument;
  const lastAt = deal.lastDocumentUpdated;
  const flagged = !!status && status.attention.length > 0 && !passed;
  const segments = status ? Math.max(status.foldersTotal, 1) : 8;

  return (
    <article
      className={cn(
        "dash-panel group relative flex flex-col transition-[border-color,box-shadow] hover:border-(--dash-blue-4) hover:shadow-[0_12px_28px_-20px_oklch(0.25_0.05_252/0.45)]",
        passed && "opacity-70 hover:opacity-100",
      )}
    >
      {/* Whole-card link; inner controls sit above it (relative z-10). */}
      <Link href={`/data-room/${deal.id}`} className="absolute inset-0 z-0 rounded-[8px]" aria-label={`Open ${name} data room`} />

      <div className="pointer-events-none relative z-10 flex flex-1 flex-col gap-3.5 px-5 pt-4 pb-4">
        <header className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h3 className="truncate text-[0.9375rem] font-semibold text-(--dash-ink) group-hover:text-(--dash-blue)" title={name}>{name}</h3>
            {flagged && (
              <span className="mt-1 size-2 shrink-0 rounded-full bg-(--dash-brass)" title="Needs attention" aria-label="Needs attention" />
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-(--dash-ink-3)">
            <span className="truncate">{industry || "No industry"}</span>
            {showCreated && (
              <span className="shrink-0">· created {new Date(deal.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            )}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className={cn("text-xs font-medium", passed ? "text-(--dash-ink-3)" : "text-(--dash-ink-2)")}>
              {passed ? "Passed" : stageLabel(deal.stage || "INITIAL_REVIEW")}
            </span>
            {!passed && step > 0 && (
              <span className="flex gap-0.5" aria-hidden>
                {Array.from({ length: STAGE_STEP_COUNT }).map((_, i) => (
                  <span key={i} className="h-[3px] w-2 rounded-full" style={{ background: i < step ? "var(--dash-blue)" : "var(--dash-rule)" }} />
                ))}
              </span>
            )}
          </div>
        </header>

        {/* Coverage */}
        <div>
          <div className="flex h-1.5 gap-0.5" aria-hidden>
            {Array.from({ length: segments }).map((_, i) => (
              <span
                key={i}
                className="h-full flex-1 rounded-full"
                style={{ background: status && i < status.foldersFilled ? "var(--dash-blue-2)" : "var(--dash-wash)" }}
              />
            ))}
          </div>
          <div className="mt-1.5 text-xs">
            {status ? (
              status.foldersTotal === 0 ? (
                <span className="text-(--dash-ink-3)">No folders yet — open the room to set it up</span>
              ) : (
                <span className="dash-num text-(--dash-ink-2)">
                  <span className="font-semibold text-(--dash-ink)">{status.foldersFilled} of {status.foldersTotal}</span> folders
                  {" · "}{status.documents} {status.documents === 1 ? "document" : "documents"}
                </span>
              )
            ) : failed ? (
              <button type="button" onClick={onRetry} className="pointer-events-auto relative z-20 inline-flex items-center gap-1 text-(--dash-ink-3) hover:text-(--dash-blue)">
                Stats unavailable <span aria-hidden className="material-symbols-outlined text-[14px]">refresh</span>
              </button>
            ) : (
              <Skeleton.Line width={150} height={11} />
            )}
          </div>
        </div>

        {/* Latest upload */}
        <div className="flex items-center gap-2 text-xs">
          {lastDoc ? (
            <>
              <span aria-hidden className="material-symbols-outlined text-[16px] text-(--dash-ink-3)">{fileIcon(lastDoc)}</span>
              <span className="min-w-0 flex-1 truncate text-(--dash-ink)" title={lastDoc}>{lastDoc}</span>
              {lastAt && <span className="shrink-0 text-(--dash-ink-3)">{touchLabel(lastAt, now)}</span>}
            </>
          ) : (
            <span className="text-(--dash-ink-3)">No documents yet</span>
          )}
        </div>

        {/* Signals — only when there's something to say */}
        {status && (status.openRequests.length > 0 || status.liveShares.length > 0 || flagged) && (
          <div className="flex flex-wrap gap-1.5">
            {status.openRequests.map((r) => (
              <Chip key={r.id} tone={r.expiresAt && dayOffset(r.expiresAt, now) <= 3 ? "brass" : "blue"}>
                <span aria-hidden className="material-symbols-outlined text-[13px]">move_to_inbox</span>
                Request · {r.receivedCount}/{r.totalCount} in
              </Chip>
            ))}
            {status.liveShares.length > 0 && (
              <Chip>
                <span aria-hidden className="material-symbols-outlined text-[13px]">link</span>
                Shared · {status.shareViews} {status.shareViews === 1 ? "view" : "views"}
              </Chip>
            )}
            {flagged && status.attention.slice(0, 1).map((a) => <Chip key={a} tone="brass">{a}</Chip>)}
          </div>
        )}
      </div>

      <footer className="relative z-10 flex items-center justify-between border-t border-(--dash-rule) px-5 py-2.5 text-xs">
        <Link href={`/data-room/${deal.id}`} className="font-semibold text-(--dash-blue) hover:underline">Open room →</Link>
        <Link href={`/deals/${deal.id}?tab=Documents`} className="text-(--dash-ink-3) hover:text-(--dash-ink)">Request documents</Link>
      </footer>
    </article>
  );
}

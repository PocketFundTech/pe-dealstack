"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { DOC_TYPE_LABELS, STATUS_COLOR_CLASSES, STATUS_LABELS } from "./constants";
import { CreateTile, ImportGdocTile, UploadExistingTile } from "./GalleryTiles";
import { isImportedGdoc, type DocStatus, type LegalDocumentWithDeal } from "./types";

interface DocCardProps {
  doc: LegalDocumentWithDeal;
  onEdit: (doc: LegalDocumentWithDeal) => void;
  onDelete: (doc: LegalDocumentWithDeal) => void;
}

function formatDateShort(d: string | null): string | null {
  if (!d) return null;
  // The wire format is YYYY-MM-DD or an ISO string. Parsing without TZ on a
  // bare date causes "Apr 30" to flip to "Apr 29" in UTC- timezones, so we
  // pin to noon UTC for bare dates to keep the day stable.
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d;
  const parsed = new Date(safe);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function DocCard({ doc, onEdit, onDelete }: DocCardProps) {
  const dealLabel = doc.deal.target || doc.deal.projectName || "Unknown deal";
  const statusCls = STATUS_COLOR_CLASSES[doc.status];
  const effective = formatDateShort(doc.effectiveDate);
  const expires = formatDateShort(doc.expiresAt);
  const counterparty = doc.counterpartyName?.trim();
  // Sent docs with a live Google Doc get a subtle emerald badge in the
  // bottom corner — signals that edits there are the source of truth, even
  // though the card itself still routes to the in-app editor (audit trail).
  const hasGoogleDoc = doc.status === "SENT" && !!doc.googleDocUrl;
  // Signatures the backend auto-detected flip the doc to SIGNED and stamp
  // metadata.signatureDetectedVia — 'drive-poll' (on-demand polling, the active
  // path) or 'drive-watch' (the dormant push path). Either provenance surfaces
  // the badge so operators know it wasn't marked Signed by hand.
  const autoDetectedSignature =
    doc.status === "SIGNED" &&
    Boolean(
      (doc.metadata as { signatureDetectedVia?: string } | undefined)
        ?.signatureDetectedVia,
    );
  // "Bring your own Google Doc" rows get a slate chip so the user can tell at a
  // glance the NDA lives in Drive (and clicking opens the preview view, not the
  // HTML editor). Only show it when the two emerald badges above aren't already
  // claiming the bottom-left corner — they're more specific signals.
  const importedGdoc = isImportedGdoc(doc);
  const showImportedChip =
    importedGdoc && !hasGoogleDoc && !autoDetectedSignature;

  return (
    <div className="group relative aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm hover:shadow-md transition overflow-hidden">
      {/* Card body — clicking drops the user into the full in-app editor.
          Pencil/trash are hover-only affordances. */}
      <button
        onClick={() => onEdit(doc)}
        className="absolute inset-0 text-left"
        aria-label={`Open ${doc.title}`}
      >
        <span className="sr-only">Open NDA</span>
      </button>

      {hasGoogleDoc && (
        <div
          className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 pointer-events-none"
          title="Lives in Google Docs — counterparty has edit access"
        >
          <span className="material-symbols-outlined text-[12px]">cloud_done</span>
          Google Docs
        </div>
      )}

      {autoDetectedSignature && (
        <div
          className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 pointer-events-none"
          title="Signature auto-detected from the Google Doc lock — not marked Signed by hand"
        >
          <span className="material-symbols-outlined text-[12px]">verified</span>
          Signed · auto-detected
        </div>
      )}

      {showImportedChip && (
        <div
          className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 pointer-events-none"
          title="Imported from a Google Doc — opens an embedded preview, not the HTML editor"
        >
          <span className="material-symbols-outlined text-[12px]">cloud_done</span>
          Google Doc
        </div>
      )}

      <div className="relative px-4 pt-3 pb-1 pointer-events-none">
        <div className="text-[10px] uppercase tracking-wider text-[#003366] font-medium truncate">
          {dealLabel}
        </div>
        <div className="flex items-start justify-between gap-2 mt-0.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 truncate">
              {doc.title}
            </div>
            <div className="text-[11px] text-slate-500 truncate">
              {counterparty ? counterparty : (
                <span className="text-slate-400">No counterparty</span>
              )}
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border",
              statusCls.bg,
              statusCls.text,
              statusCls.border,
            )}
          >
            {STATUS_LABELS[doc.status]}
          </span>
        </div>
      </div>

      {/* Bottom strip — effective / expires dates if present, doc-type
          fallback otherwise. Keeps the card visually balanced even when an
          NDA has zero metadata filled in yet. */}
      <div className="absolute inset-x-0 bottom-0 top-[72px] px-4 py-3 pointer-events-none">
        <div className="h-full rounded-lg border border-dashed border-slate-200 bg-slate-50/60 flex flex-col items-center justify-center px-3 gap-1.5">
          {effective || expires ? (
            <>
              {effective && (
                <DateRow icon="event_available" label="Effective" value={effective} />
              )}
              {expires && (
                <DateRow icon="event_busy" label="Expires" value={expires} />
              )}
            </>
          ) : (
            <span className="text-[11px] text-slate-400">
              {DOC_TYPE_LABELS[doc.docType]} · no dates set
            </span>
          )}
        </div>
      </div>

      {/* Hover affordances */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition flex gap-1 z-10">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(doc);
          }}
          className="w-7 h-7 rounded-md bg-white border border-slate-200 text-slate-600 hover:text-[#003366] hover:border-[#003366] shadow-sm flex items-center justify-center"
          title="Open editor"
        >
          <span className="material-symbols-outlined text-[14px]">edit</span>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(doc);
          }}
          className="w-7 h-7 rounded-md bg-white border border-slate-200 text-slate-600 hover:text-rose-700 hover:border-rose-300 shadow-sm flex items-center justify-center"
          title="Delete"
        >
          <span className="material-symbols-outlined text-[14px]">delete</span>
        </button>
      </div>
    </div>
  );
}

function DateRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
      <span className="material-symbols-outlined text-[14px] text-slate-400">
        {icon}
      </span>
      <span className="text-slate-400">{label}:</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────
// Status-bucketed tabs sit just above the card grid. Drafts is the default
// view on first paint — the user's most common reason to open /nda is to
// finish drafting something. Sent / Signed surface the import CTA instead
// of the New NDA tile since "uploading something already done" is the only
// reasonable action on those tabs.
type TabKey = "drafts" | "sent" | "signed" | "all";

const TABS: ReadonlyArray<{ key: TabKey; label: string; status: DocStatus | null }> = [
  { key: "drafts", label: "Drafts", status: "DRAFT" },
  { key: "sent", label: "Sent", status: "SENT" },
  { key: "signed", label: "Signed", status: "SIGNED" },
  { key: "all", label: "All", status: null },
] as const;

function filterByTab(docs: LegalDocumentWithDeal[], tab: TabKey): LegalDocumentWithDeal[] {
  const def = TABS.find((t) => t.key === tab);
  if (!def?.status) return docs;
  return docs.filter((d) => d.status === def.status);
}

interface GalleryProps {
  docs: LegalDocumentWithDeal[];
  loading: boolean;
  error: string | null;
  onCreate: () => void;
  onUploadExisting: () => void;
  onImportGdoc: () => void;
  onEdit: (doc: LegalDocumentWithDeal) => void;
  onDelete: (doc: LegalDocumentWithDeal) => void;
  onDismissError: () => void;
}

export function Gallery({
  docs,
  loading,
  error,
  onCreate,
  onUploadExisting,
  onImportGdoc,
  onEdit,
  onDelete,
  onDismissError,
}: GalleryProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("drafts");

  // Per-tab counts feed the badge next to each tab label. Precomputed in a
  // single pass so we don't rescan the array four times on every render.
  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { drafts: 0, sent: 0, signed: 0, all: docs.length };
    for (const d of docs) {
      if (d.status === "DRAFT") c.drafts += 1;
      else if (d.status === "SENT") c.sent += 1;
      else if (d.status === "SIGNED") c.signed += 1;
    }
    return c;
  }, [docs]);

  const visible = useMemo(() => filterByTab(docs, activeTab), [docs, activeTab]);

  // Drafts + All show the New NDA tile; Sent + Signed show the Upload
  // Existing tile instead. Keeps the primary action on every tab obviously
  // bucket-appropriate.
  const showCreateTile = activeTab === "drafts" || activeTab === "all";
  const uploadCtaStatus: "SENT" | "SIGNED" | null =
    activeTab === "sent" ? "SENT" : activeTab === "signed" ? "SIGNED" : null;

  return (
    <div className="max-w-[1280px] mx-auto px-8 py-7">
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">NDAs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Draft, edit, and send NDAs in-app. Click a card to open the
            editor; metadata feeds dashboards and reports.
          </p>
        </div>
        <div className="text-xs text-slate-400">
          {loading ? "Loading…" : `${docs.length} saved`}
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
          <button
            onClick={onDismissError}
            className="ml-auto text-red-400 hover:text-red-600"
            aria-label="Dismiss error"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}

      {/* Tab strip — Banker Blue underline on active, muted slate on rest.
          Border-bottom on the container so the active tab visually "owns"
          the divider line. */}
      <div className="border-b border-slate-200 mb-5">
        <div className="flex gap-6">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            const count = counts[tab.key];
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "pb-2.5 px-1 -mb-px border-b-2 text-sm transition-colors",
                  isActive
                    ? "border-[#003366] text-[#003366] font-semibold"
                    : "border-transparent text-slate-500 hover:text-slate-700 font-medium",
                )}
              >
                {tab.label}
                <span
                  className={cn(
                    "ml-1.5 text-[11px] font-normal",
                    isActive ? "text-[#003366]/70" : "text-slate-400",
                  )}
                >
                  ({count})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {showCreateTile && <CreateTile onClick={onCreate} />}
        {/* The import-gdoc entry sits with the New NDA tile (drafts/all) since
            importing then sending is a draft-creation path, not an archive of
            something already done. */}
        {showCreateTile && <ImportGdocTile onClick={onImportGdoc} />}
        {uploadCtaStatus && (
          <UploadExistingTile status={uploadCtaStatus} onClick={onUploadExisting} />
        )}

        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : visible.length === 0 ? (
          <EmptyCard activeTab={activeTab} />
        ) : (
          visible.map((d) => (
            <DocCard
              key={d.id}
              doc={d}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="relative aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden animate-pulse">
      <div className="px-4 pt-3 pb-1 space-y-2">
        <div className="h-2.5 w-24 bg-slate-200 rounded" />
        <div className="h-3.5 w-3/4 bg-slate-200 rounded" />
        <div className="h-2.5 w-1/3 bg-slate-100 rounded" />
      </div>
      <div className="absolute inset-x-0 bottom-0 top-[72px] px-4 py-3">
        <div className="h-full rounded-lg bg-slate-50 border border-dashed border-slate-200" />
      </div>
    </div>
  );
}

interface EmptyCardProps {
  activeTab: TabKey;
}

function EmptyCard({ activeTab }: EmptyCardProps) {
  const copy: Record<TabKey, { title: string; hint: React.ReactNode }> = {
    drafts: {
      title: "No drafts yet",
      hint: (
        <>
          Click{" "}
          <span className="inline-flex items-center gap-0.5 text-[#003366] font-medium">
            New NDA
          </span>{" "}
          above to start drafting one from a verified template.
        </>
      ),
    },
    sent: {
      title: "No sent NDAs yet",
      hint: (
        <>
          Drafts you send appear here. You can also{" "}
          <span className="inline-flex items-center gap-0.5 text-[#003366] font-medium">
            Upload Existing
          </span>{" "}
          NDAs that were sent outside the app.
        </>
      ),
    },
    signed: {
      title: "No signed NDAs yet",
      hint: (
        <>
          Once an NDA is countersigned, mark it Signed in the editor — or use{" "}
          <span className="inline-flex items-center gap-0.5 text-[#003366] font-medium">
            Upload Existing
          </span>{" "}
          to import a signed copy.
        </>
      ),
    },
    all: {
      title: "No NDAs yet",
      hint: (
        <>
          Open a deal and click{" "}
          <span className="inline-flex items-center gap-0.5 text-[#003366] font-medium">
            New NDA
          </span>
          , or pick a deal here to start one.
        </>
      ),
    },
  };
  const { title, hint } = copy[activeTab];
  return (
    <div className="aspect-[4/3] rounded-xl border border-slate-200 bg-white shadow-sm flex flex-col items-center justify-center text-center px-6">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <span className="material-symbols-outlined text-[24px]">gavel</span>
      </div>
      <div className="text-sm font-medium text-slate-700">{title}</div>
      <div className="text-[12px] text-slate-500 max-w-xs mt-1">{hint}</div>
    </div>
  );
}

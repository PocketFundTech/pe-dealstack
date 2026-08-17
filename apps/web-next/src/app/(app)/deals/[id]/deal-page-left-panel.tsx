"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { cn } from "@/lib/cn";
import { getDealDisplayName } from "@/lib/formatters";

import {
  type DealDetail,
  type DocItem,
  type Activity,
  type Tab,
  TABS,
  OverviewTab,
  DocumentsTab,
  ActivityTab,
  StagePipeline,
  DealMetadataRow,
  FinancialMetricsRow,
  FinancialStatementsSection,
  DealAnalysisSection,
  DealActionsMenu,
  DealViewers,
  FinancialStatusBadge,
} from "./components";
import { DealScorecardSection } from "./deal-scorecard-section";
import { DealTeasers } from "./DealTeasers";
import { DocRequestsPanel } from "./doc-requests-panel";

// ---------------------------------------------------------------------------
// Left panel — deal content (icon, title, stage pipeline, metadata, financial
// rows, financial statements, AI analysis, then a tab switcher with Overview/
// Documents/Activity content).
//
// State (active tab, deal, documents, activities) lives in page.tsx. The
// resizable panel ref + style also stay in the parent because they're shared
// with the right panel and the drag handle. We accept them as props.
// ---------------------------------------------------------------------------

export interface DealPageLeftPanelProps {
  deal: DealDetail;
  dealId: string;
  leftRef: RefObject<HTMLElement | null>;
  leftPanelStyle: React.CSSProperties | undefined;

  // Tabs
  activeTab: Tab;
  setActiveTab: Dispatch<SetStateAction<Tab>>;

  // Stage interactions
  onStageClick: (targetStage: string) => void;
  onChangeStage: () => void;

  // Delete
  onDelete: () => void;

  // Overview / activity
  activities: Activity[];
  activitiesLoading: boolean;
  loadActivities: () => Promise<void>;

  // Documents
  documents: DocItem[];
  uploading: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  driveImporting: boolean;
  onImportFromDrive: () => void;

  // Fullscreen overlay openers (Financials / Analysis sections)
  onOpenFinancialsFullscreen: () => void;
  onOpenAnalysisFullscreen: () => void;
}

export function DealPageLeftPanel({
  deal,
  dealId,
  leftRef,
  leftPanelStyle,
  activeTab,
  setActiveTab,
  onStageClick,
  onChangeStage,
  onDelete,
  activities,
  activitiesLoading,
  loadActivities,
  documents,
  uploading,
  fileInputRef,
  onUpload,
  driveImporting,
  onImportFromDrive,
  onOpenFinancialsFullscreen,
  onOpenAnalysisFullscreen,
}: DealPageLeftPanelProps) {
  return (
    <section
      ref={leftRef as RefObject<HTMLElement>}
      className="w-full lg:w-7/12 xl:w-1/2 flex flex-col overflow-y-auto border-r border-border-subtle bg-surface-card p-6 custom-scrollbar"
      style={leftPanelStyle}
    >
      {/* Deal content */}
      <div className="flex flex-col gap-3">
        {/* Deal header */}
        <div className="flex justify-between items-start">
          <div className="flex items-start gap-4">
            <div className="size-16 rounded-xl bg-white p-1 border border-border-subtle shadow-card">
              <div className="w-full h-full bg-primary-light rounded-lg flex items-center justify-center border border-border-subtle">
                <span className="material-symbols-outlined text-primary text-3xl">
                  {deal.icon || "business"}
                </span>
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-main leading-tight">
                {getDealDisplayName(deal)}
              </h1>
              {/* Recently active team members ("@User on this deal") */}
              {(deal.team?.length ?? 0) > 0 && (
                <DealViewers team={deal.team || []} />
              )}
              <div className="flex flex-wrap gap-2 mt-1">
                {/* Financial status badge */}
                <FinancialStatusBadge dealId={dealId} />
              </div>
            </div>
          </div>
          {/* Deal Actions Menu */}
          <DealActionsMenu
            dealId={dealId}
            dealName={deal.name}
            onDelete={onDelete}
          />
        </div>

        {/* Stage Pipeline */}
        <StagePipeline
          deal={deal}
          onStageClick={onStageClick}
          onChangeStage={onChangeStage}
        />

        {/* Metadata row */}
        <DealMetadataRow deal={deal} />

        {/* Financial metrics row */}
        <FinancialMetricsRow deal={deal} />

        {/* Deal Scorecard section */}
        <DealScorecardSection dealId={dealId} initialScorecard={deal.scorecard} />

        {/* Financial Statements section */}
        <FinancialStatementsSection dealId={dealId} onFullscreen={onOpenFinancialsFullscreen} />

        {/* AI Financial Analysis section */}
        <DealAnalysisSection dealId={dealId} onFullscreen={onOpenAnalysisFullscreen} />

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border-subtle mt-1">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-3 text-sm font-medium transition-colors relative",
                activeTab === tab
                  ? "text-primary"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              {tab}
              {activeTab === tab && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div>
          {activeTab === "Overview" && (
            <OverviewTab
              deal={deal}
              activities={activities}
              activitiesLoading={activitiesLoading}
              onRefreshActivities={loadActivities}
            />
          )}
          {activeTab === "Documents" && (
            <div className="flex flex-col gap-8">
              <DocumentsTab
                documents={documents}
                uploading={uploading}
                fileInputRef={fileInputRef}
                onUpload={onUpload}
                driveImporting={driveImporting}
                onImportFromDrive={onImportFromDrive}
              />
              {/* Asking for documents belongs next to receiving them. */}
              <DocRequestsPanel dealId={deal.id} />
            </div>
          )}
          {activeTab === "Activity" && (
            <ActivityTab
              activities={activities}
              loading={activitiesLoading}
              dealId={deal.id}
            />
          )}
          {activeTab === "Teaser" && <DealTeasers dealId={dealId} />}
        </div>
      </div>
    </section>
  );
}

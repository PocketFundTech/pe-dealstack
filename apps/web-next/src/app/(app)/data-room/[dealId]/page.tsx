"use client";

import { use, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FiltersBar } from "@/components/vdr/FiltersBar";
import { InsightsPanel } from "@/components/vdr/InsightsPanel";
import { DEFAULT_SMART_FILTERS } from "@/lib/vdr/filters";
import type {
  Folder,
  FolderInsights,
  SmartFilter,
  VDRFile,
} from "@/lib/vdr/types";
import {
  CreateFolderModal,
  DataRoomHeader,
  DataRoomLoading,
  LinkToDealModal,
  UploadConfirmModal,
  VDRToast,
} from "./components";
import {
  FolderSidebar,
  SearchStatusBanner,
  FileListSection,
} from "./page-sections";
import { ManageTeamModal } from "@/app/(app)/deals/[id]/manage-team-modal";
import type { TeamMember as DealTeamMember } from "@/app/(app)/deals/[id]/components";
import {
  DataRoomFilters,
  DEFAULT_DATA_ROOM_FILTERS,
  applyDataRoomFilters,
  type DataRoomFilterState,
} from "./data-room-filters";
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_FILE_SIZE,
  hasHighValueDoc,
} from "./upload-helpers";
import {
  createCreateFolder,
  createDeleteFolder,
  createConfirmDeleteFolder,
  createRenameFolder,
  createDeleteFile,
  createConfirmDeleteFile,
  createRenameFile,
  createFileClick,
  createReanalyze,
  createExtractFinancials,
  createLinkToDeal,
  createConfirmLinkToDeal,
  createGenerateInsights,
  createRequestDocument,
  createConfirmUpload,
} from "./file-handlers";
import { useInitialLoad, useFolderInsights, useProcessingPoll, useInsightsCollapse } from "./data-loaders";
import { generateVDRReport } from "./report-generator";

interface PageProps {
  params: Promise<{ dealId: string }>;
}

export default function DataRoomDealPage({ params }: PageProps) {
  const { dealId } = use(params);
  const router = useRouter();

  const [dealName, setDealName] = useState<string>("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState<VDRFile[]>([]);
  const [insights, setInsights] = useState<Record<string, FolderInsights>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<SmartFilter[]>(DEFAULT_SMART_FILTERS);
  const [dataRoomFilters, setDataRoomFilters] = useState<DataRoomFilterState>(DEFAULT_DATA_ROOM_FILTERS);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; role: string; user?: { name?: string; avatar?: string; email?: string } }>>([]);
  const [showTeamModal, setShowTeamModal] = useState(false);
  // Upload confirmation modal state (two-stage upload like legacy)
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  const [autoUpdateDeal, setAutoUpdateDeal] = useState(false);
  // Link-to-deal modal state
  const [linkModalFile, setLinkModalFile] = useState<VDRFile | null>(null);
  const [linkDeals, setLinkDeals] = useState<Array<{ id: string; name: string; industry?: string }>>([]);
  const [linkSearchQuery, setLinkSearchQuery] = useState("");
  const [linking, setLinking] = useState(false);
  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const [insightsCollapsed, handleToggleInsightsCollapse] = useInsightsCollapse();
  const isSearching = searchQuery.trim().length > 0;

  useInitialLoad({
    dealId,
    activeFolderId,
    setLoading,
    setDealName,
    setTeamMembers,
    setFolders,
    setActiveFolderId,
    setAllFiles,
  });

  useFolderInsights({ activeFolderId, setInsights });
  useProcessingPoll({ dealId, activeFolderId, allFiles, setAllFiles });

  // ─── Derived data ────────────────────────────────────────────────
  const filteredFiles = useMemo(() => {
    // The data-room "Folder" filter (in DataRoomFilters) overrides the active
    // sidebar folder when it's set — letting the user filter to a specific
    // folder OR show files across all folders without leaving the active page.
    const useGlobalScope =
      isSearching || !!dataRoomFilters.folderId || !!dataRoomFilters.fileType;
    const base = useGlobalScope
      ? allFiles
      : allFiles.filter((f) => f.folderId === activeFolderId);

    const activeFilters = filters.filter((f) => f.active);
    const afterSmartFilters = activeFilters.length
      ? base.filter((file) => activeFilters.every((f) => f.filterFn(file)))
      : base;

    const q = searchQuery.toLowerCase().trim();
    const afterSearch = q
      ? afterSmartFilters.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            f.analysis.description.toLowerCase().includes(q) ||
            (f.tags || []).some((t) => t.toLowerCase().includes(q)),
        )
      : afterSmartFilters;

    return applyDataRoomFilters(afterSearch, dataRoomFilters);
  }, [allFiles, activeFolderId, isSearching, filters, searchQuery, dataRoomFilters]);

  const activeFolder = folders.find((f) => f.id === activeFolderId);
  const activeFolderInsights = activeFolderId ? insights[activeFolderId] : null;

  // ─── Handlers ────────────────────────────────────────────────────
  const handleFilterToggle = (id: string) => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, active: !f.active } : f)));
  };

  const handleAddCustomFilter = (f: SmartFilter) => setFilters((prev) => [...prev, f]);
  const handleRemoveCustomFilter = (id: string) =>
    setFilters((prev) => prev.filter((f) => f.id !== id));

  const handleUploadClick = () => {
    setUploadError(null);
    if (!activeFolderId) {
      setUploadError("Select a folder first.");
    }
  };

  // Stage 1: Files selected -> show confirmation modal
  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-selecting the same file
    if (!files.length || !activeFolderId) return;

    const validFiles: File[] = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_FILE_SIZE) {
        showToast(`File "${file.name}" exceeds maximum size of 50MB`, "error");
        continue;
      }
      if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.type)) {
        showToast(`File "${file.name}" has an unsupported file type`, "error");
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length > 0) {
      // Smart default: auto-check toggle for CIM/financials/teaser documents
      setAutoUpdateDeal(hasHighValueDoc(validFiles));
      setPendingUploadFiles(validFiles);
    }
  };

  // Stage 2: User confirms upload
  const handleConfirmUpload = useCallback(() => {
    return createConfirmUpload({
      dealId, activeFolderId, pendingUploadFiles, autoUpdateDeal,
      setUploading, setPendingUploadFiles, setUploadError,
      setAllFiles, setFolders, showToast,
    })();
  }, [
    dealId, activeFolderId, pendingUploadFiles, autoUpdateDeal,
    setUploading, setPendingUploadFiles, setUploadError,
    setAllFiles, setFolders, showToast,
  ]);

  const [pendingDelete, setPendingDelete] = useState<{ type: "folder" | "file"; id: string; name: string; extra?: string } | null>(null);

  // ─── Folder + file action factories ─────────────────────────────────────
  // Closure-bound factories from file-handlers.ts. Each factory receives the
  // bits of state/setters it needs and returns the same handler we used to
  // declare inline. Behavior is unchanged from the original page.tsx.
  const folderDeps = {
    dealId,
    folders,
    activeFolderId,
    newFolderName,
    creatingFolder,
    setFolders,
    setActiveFolderId,
    setShowCreateFolder,
    setNewFolderName,
    setCreatingFolder,
    setAllFiles,
    setPendingDelete,
  };
  const handleCreateFolder = createCreateFolder(folderDeps);
  const handleDeleteFolder = createDeleteFolder(folderDeps);
  const confirmDeleteFolder = createConfirmDeleteFolder(folderDeps);
  const handleRenameFolder = createRenameFolder(folderDeps);

  const fileDeps = {
    dealId,
    allFiles,
    setAllFiles,
    setFolders,
    setPendingDelete,
    showToast,
  };
  const handleDeleteFile = createDeleteFile(fileDeps);
  const confirmDeleteFile = createConfirmDeleteFile(fileDeps);
  const handleRenameFile = createRenameFile(fileDeps);

  // -------------------------------------------------------------------------
  // In-app document preview — intentional MVP decision (audit A3)
  //
  // The legacy docPreview.js rendered PDF, Excel, Word, and CSV
  // files entirely in-browser using PDF.js (PDF), SheetJS (XLSX), and
  // Mammoth.js (DOCX). That 543-line subsystem was intentionally NOT ported
  // during the migration to web-next.
  //
  // The current approach — window.open(signedUrl, "_blank") — covers the 80%
  // case: modern browsers render PDFs inline in a new tab, XLSX/DOCX files
  // get downloaded by the browser (there is no in-app renderer), and CSV
  // opens as plaintext. This is sufficient for MVP.
  //
  // NOTE: The API currently returns a raw Supabase signed URL without setting
  // Content-Disposition: inline. Browsers still render PDFs inline by default
  // when opened in a new tab, but explicit inline disposition would make the
  // behaviour more reliable across browsers. That is a separate concern in
  // the API layer — do not change it here.
  //
  // If product wants in-app Excel/Word rendering back: port
  // docPreview.js and add `xlsx` + `mammoth` to
  // apps/web-next/package.json. Reference: docs/MIGRATION-AUDIT-REPORT.md A3.
  // -------------------------------------------------------------------------
  const handleFileClick = useCallback((file: VDRFile) => {
    return createFileClick({ showToast })(file);
  }, [showToast]);
  const handleReanalyze = useCallback((file: VDRFile) => {
    return createReanalyze({ dealId, showToast, setAllFiles })(file);
  }, [dealId, showToast, setAllFiles]);
  const handleExtractFinancials = useCallback((file: VDRFile) => {
    return createExtractFinancials({ dealId, showToast })(file);
  }, [dealId, showToast]);

  const linkDeps = {
    dealId,
    linkModalFile,
    linkDeals,
    showToast,
    setLinkModalFile,
    setLinkDeals,
    setLinkSearchQuery,
    setLinking,
  };
  const handleLinkToDeal = useCallback((file: VDRFile) => {
    return createLinkToDeal(linkDeps)(file);
  }, [linkDeps]);
  const confirmLinkToDeal = useCallback((dealIdToLink: string) => {
    return createConfirmLinkToDeal(linkDeps)(dealIdToLink);
  }, [linkDeps]);

  const insightsDeps = {
    dealId,
    activeFolderId,
    generating,
    activeFolder: undefined as Folder | undefined, // re-bound below after activeFolder is computed
    activeFolderInsights: undefined as FolderInsights | null | undefined, // re-bound below
    setInsights,
    setFolders,
    setGenerating,
  };
  // activeFolder/activeFolderInsights are derived above this line. Re-attach
  // them before constructing the handlers so the factories have current refs.
  insightsDeps.activeFolder = activeFolder;
  insightsDeps.activeFolderInsights = activeFolderInsights;
  const handleGenerateInsights = useCallback(() => {
    return createGenerateInsights(insightsDeps)();
  }, [insightsDeps]);

  // Generate Full Report — downloads a markdown file (matching legacy behavior)
  const handleGenerateReport = useCallback(() => {
    if (!activeFolder) return;
    generateVDRReport({ activeFolder, activeFolderInsights, filteredFiles });
  }, [activeFolder, activeFolderInsights, filteredFiles]);

  // Handle "View File" from insights panel red flags
  const handleViewFile = useCallback((fileId: string) => {
    const file = allFiles.find((f) => f.id === fileId);
    if (file) handleFileClick(file);
  }, [allFiles, handleFileClick]);

  const handleRequestDocument = createRequestDocument(insightsDeps);

  if (loading) {
    return <DataRoomLoading />;
  }

  return (
    <div className="flex h-full w-full bg-slate-50 overflow-hidden">
      {showCreateFolder && (
        <CreateFolderModal
          newFolderName={newFolderName}
          onNameChange={setNewFolderName}
          creatingFolder={creatingFolder}
          onSubmit={handleCreateFolder}
          onClose={() => {
            setShowCreateFolder(false);
            setNewFolderName("");
          }}
        />
      )}

      {/* Folder sidebar */}
      <FolderSidebar
        dealName={dealName}
        folders={folders}
        activeFolderId={activeFolderId}
        onFolderSelect={setActiveFolderId}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onNewFolder={() => setShowCreateFolder(true)}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50 relative">
        <DataRoomHeader
          dealId={dealId}
          dealName={dealName}
          activeFolder={activeFolder}
          activeFolderId={activeFolderId}
          uploading={uploading}
          teamMembers={teamMembers}
          onBack={() => router.back()}
          onClearFolder={() => setActiveFolderId(null)}
          onUploadClick={handleUploadClick}
          onFilesSelected={handleFilesSelected}
          onManageTeam={() => setShowTeamModal(true)}
        />

        <FiltersBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          filters={filters}
          onFilterToggle={handleFilterToggle}
          onAddCustomFilter={handleAddCustomFilter}
          onRemoveCustomFilter={handleRemoveCustomFilter}
        />

        <DataRoomFilters
          filters={dataRoomFilters}
          onChange={setDataRoomFilters}
          folders={folders}
        />

        {isSearching && (
          <SearchStatusBanner
            searchQuery={searchQuery}
            resultCount={filteredFiles.length}
            onClear={() => setSearchQuery("")}
          />
        )}

        {uploadError && (
          <div className="mx-6 mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {uploadError}
          </div>
        )}

        <FileListSection
          filteredFiles={filteredFiles}
          folders={folders}
          activeFolder={activeFolder}
          activeFolderId={activeFolderId}
          isSearching={isSearching}
          dataRoomFilters={dataRoomFilters}
          onFileClick={handleFileClick}
          onDeleteFile={handleDeleteFile}
          onRenameFile={handleRenameFile}
          onLinkToDeal={handleLinkToDeal}
          onExtractFinancials={handleExtractFinancials}
          onReanalyze={handleReanalyze}
        />
      </main>

      <InsightsPanel
        insights={activeFolderInsights}
        folderName={activeFolder?.name || ""}
        onGenerateReport={handleGenerateReport}
        onViewFile={handleViewFile}
        onRequestDocument={handleRequestDocument}
        onGenerateInsights={handleGenerateInsights}
        isGenerating={generating}
        isCollapsed={insightsCollapsed}
        onToggleCollapse={handleToggleInsightsCollapse}
      />

      {pendingUploadFiles && (
        <UploadConfirmModal
          files={pendingUploadFiles}
          autoUpdateDeal={autoUpdateDeal}
          uploading={uploading}
          onAutoUpdateChange={setAutoUpdateDeal}
          onConfirm={handleConfirmUpload}
          onCancel={() => setPendingUploadFiles(null)}
        />
      )}

      {linkModalFile && (
        <LinkToDealModal
          file={linkModalFile}
          deals={linkDeals}
          searchQuery={linkSearchQuery}
          onSearchChange={setLinkSearchQuery}
          linking={linking}
          onSelect={confirmLinkToDeal}
          onClose={() => setLinkModalFile(null)}
        />
      )}

      {showTeamModal && (
        <ManageTeamModal
          dealId={dealId}
          initialTeam={teamMembers.map((m) => ({
            id: m.user?.name ? m.id : m.id,
            name: m.user?.name || "",
            email: m.user?.email,
            avatar: m.user?.avatar,
            role: m.role,
          }))}
          onClose={() => setShowTeamModal(false)}
          onTeamChanged={(team: DealTeamMember[]) => {
            // Translate the flat deal-page shape back into the nested data-room
            // shape so the avatar stack reflects updates immediately.
            setTeamMembers(
              team.map((m) => ({
                id: m.id,
                role: m.role || "MEMBER",
                user: { name: m.name, avatar: m.avatar, email: m.email },
              })),
            );
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.type === "folder" ? "Delete Folder" : "Delete File"}
        message={
          pendingDelete
            ? `Delete "${pendingDelete.name}"? This cannot be undone.${pendingDelete.extra ? ` ${pendingDelete.extra}` : ""}`
            : ""
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (!pendingDelete) return;
          if (pendingDelete.type === "folder") confirmDeleteFolder(pendingDelete.id);
          else confirmDeleteFile(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {toast && (
        <VDRToast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />
      )}
    </div>
  );
}

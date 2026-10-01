"use client";

// Page sections specific to the [dealId] route — extracted from page.tsx so
// the page itself stays under the 500-line cap. components.tsx already
// holds the modal-shaped pieces (CreateFolderModal, UploadConfirmModal,
// LinkToDealModal, DataRoomHeader, DataRoomLoading); this file
// holds the layout fragments that only this page composes (search-status
// banner, file-list section, folder sidebar).

import Link from "next/link";
import { FolderTree } from "@/components/vdr/FolderTree";
import { FileTable } from "@/components/vdr/FileTable";
import type { Folder, VDRFile } from "@/lib/vdr/types";
import type { DataRoomFilterState } from "./data-room-filters";

/* ────────────────────────────────────────────────────────────────────── */
/*  Search status banner (cross-folder search summary)                   */
/* ────────────────────────────────────────────────────────────────────── */

interface SearchStatusBannerProps {
  searchQuery: string;
  resultCount: number;
  onClear: () => void;
}

export function SearchStatusBanner({ searchQuery, resultCount, onClear }: SearchStatusBannerProps) {
  return (
    <div className="px-6 py-2 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
      <span className="material-symbols-outlined text-[18px]" style={{ color: "#003366" }}>
        search
      </span>
      <span className="text-sm text-slate-700">
        Searching across all folders — <strong>{resultCount}</strong> result
        {resultCount !== 1 ? "s" : ""} for &quot;<em>{searchQuery}</em>&quot;
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-xs font-medium text-slate-500 hover:text-slate-700 flex items-center gap-1 transition-colors"
      >
        <span className="material-symbols-outlined text-[14px]">close</span>
        Clear
      </button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  File list section (table when a scope is active, empty state otherwise) */
/* ────────────────────────────────────────────────────────────────────── */

interface FileListSectionProps {
  filteredFiles: VDRFile[];
  folders: Folder[];
  activeFolder: Folder | undefined;
  activeFolderId: string | null;
  isSearching: boolean;
  dataRoomFilters: DataRoomFilterState;
  onFileClick: (file: VDRFile) => void;
  onDeleteFile: (id: string) => void;
  onRenameFile: (id: string, name: string) => void;
  onLinkToDeal: (file: VDRFile) => void;
  onExtractFinancials: (file: VDRFile) => void;
  onReanalyze: (file: VDRFile) => void;
}

export function FileListSection({
  filteredFiles,
  folders,
  activeFolder,
  activeFolderId,
  isSearching,
  dataRoomFilters,
  onFileClick,
  onDeleteFile,
  onRenameFile,
  onLinkToDeal,
  onExtractFinancials,
  onReanalyze,
}: FileListSectionProps) {
  const hasScope =
    activeFolderId || isSearching || dataRoomFilters.fileType || dataRoomFilters.folderId;

  if (!hasScope) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4">
            folder_open
          </span>
          <p className="text-slate-500">Select a folder to view files</p>
        </div>
      </div>
    );
  }

  const folderName = isSearching
    ? "Search Results"
    : dataRoomFilters.folderId
    ? folders.find((f) => f.id === dataRoomFilters.folderId)?.name || "Folder"
    : dataRoomFilters.fileType
    ? `${dataRoomFilters.fileType} Files`
    : activeFolder?.name || "Folder";

  return (
    <FileTable
      files={filteredFiles}
      folderName={folderName}
      onFileClick={onFileClick}
      onDeleteFile={onDeleteFile}
      onRenameFile={onRenameFile}
      onLinkToDeal={onLinkToDeal}
      onExtractFinancials={onExtractFinancials}
      onReanalyze={onReanalyze}
    />
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Folder sidebar (left rail with folder tree + new-folder button)      */
/* ────────────────────────────────────────────────────────────────────── */

interface FolderSidebarProps {
  dealName: string;
  folders: Folder[];
  activeFolderId: string | null;
  onFolderSelect: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onNewFolder: () => void;
}

export function FolderSidebar({
  dealName,
  folders,
  activeFolderId,
  onFolderSelect,
  onRenameFolder,
  onDeleteFolder,
  onNewFolder,
}: FolderSidebarProps) {
  return (
    <aside className="hidden md:flex w-[280px] min-w-[280px] flex-col border-r border-slate-200 bg-white">
      <div className="p-4 border-b border-slate-200/50">
        <Link
          href="/data-room"
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-primary mb-2 transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">arrow_back</span>
          All Data Rooms
        </Link>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#003366" }}>
            {dealName || "Data Room"}
          </span>
        </div>
        <h2 className="text-base font-bold text-slate-900">Data Room</h2>
      </div>

      <FolderTree
        folders={folders}
        activeFolder={activeFolderId || ""}
        onFolderSelect={onFolderSelect}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
      />

      <div className="p-4 border-t border-slate-200 bg-slate-50/50">
        <button
          type="button"
          onClick={onNewFolder}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:text-primary transition-colors shadow-sm"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          New Folder
        </button>
      </div>
    </aside>
  );
}

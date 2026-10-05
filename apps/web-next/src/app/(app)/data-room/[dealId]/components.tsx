"use client";

import { useRef, useEffect } from "react";
import Link from "next/link";
import type { Folder, VDRFile } from "@/lib/vdr/types";

/* ────────────────────────────────────────────────────────────────────── */
/*  Loading spinner shown while the data room is initialising            */
/* ────────────────────────────────────────────────────────────────────── */

export function DataRoomLoading() {
  return (
    <div className="flex items-center justify-center h-full w-full bg-slate-50">
      <div className="text-center">
        <div
          className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4"
          style={{ borderColor: "#003366" }}
        />
        <p className="text-slate-500">Loading Data Room...</p>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Modal for creating a new folder                                      */
/* ────────────────────────────────────────────────────────────────────── */

interface CreateFolderModalProps {
  newFolderName: string;
  onNameChange: (name: string) => void;
  creatingFolder: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export function CreateFolderModal({
  newFolderName,
  onNameChange,
  creatingFolder,
  onSubmit,
  onClose,
}: CreateFolderModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-md"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div
              className="flex items-center justify-center w-9 h-9 rounded-lg"
              style={{ backgroundColor: "#E6EEF5" }}
            >
              <span className="material-symbols-outlined text-primary text-[20px]">create_new_folder</span>
            </div>
            <h3 className="text-base font-semibold text-slate-900">Create New Folder</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <span className="material-symbols-outlined text-slate-400">close</span>
          </button>
        </div>
        <div className="p-4">
          <label className="block text-sm font-medium text-slate-600 mb-2">Folder Name</label>
          <input
            ref={inputRef}
            type="text"
            value={newFolderName}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            placeholder="e.g., Tax Documents, Contracts"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm text-slate-900 placeholder:text-slate-400"
          />
          <p className="mt-2 text-xs text-slate-400">
            The folder will be created in the current deal&apos;s data room.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 p-4 border-t border-slate-200 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!newFolderName.trim() || creatingFolder}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg shadow transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
            style={{ backgroundColor: "#003366" }}
          >
            {creatingFolder ? "Creating..." : "Create Folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Breadcrumb header with upload button                                 */
/* ────────────────────────────────────────────────────────────────────── */

interface TeamMember {
  id: string;
  role: string;
  user?: { name?: string; avatar?: string };
}

interface DataRoomHeaderProps {
  dealId: string;
  dealName: string;
  activeFolder: Folder | undefined;
  activeFolderId: string | null;
  uploading: boolean;
  teamMembers?: TeamMember[];
  onBack: () => void;
  onClearFolder: () => void;
  onUploadClick: () => void;
  onFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onManageTeam: () => void;
}

function getInitials(name: string): string {
  if (!name) return "?";
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

export function DataRoomHeader({
  dealId,
  dealName,
  activeFolder,
  activeFolderId,
  uploading,
  teamMembers = [],
  onBack,
  onClearFolder,
  onUploadClick,
  onFilesSelected,
  onManageTeam,
}: DataRoomHeaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = () => {
    if (!activeFolderId) return;
    onUploadClick();
    fileInputRef.current?.click();
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6 shrink-0 gap-4">
      <nav className="flex items-center gap-1.5 text-sm min-w-0 overflow-hidden">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center size-7 rounded-md hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors mr-1 shrink-0"
          title="Go back"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <Link href="/deals" className="text-slate-400 hover:text-blue-600 transition-colors shrink-0">
          Deals
        </Link>
        <span className="material-symbols-outlined text-[14px] text-slate-300 shrink-0">
          chevron_right
        </span>
        <Link
          href={`/deals/${dealId}`}
          className="text-slate-500 hover:text-blue-600 transition-colors truncate max-w-[120px]"
        >
          {dealName || "Deal"}
        </Link>
        <span className="material-symbols-outlined text-[14px] text-slate-300 shrink-0">
          chevron_right
        </span>
        {activeFolder ? (
          <>
            <button
              type="button"
              onClick={onClearFolder}
              className="text-slate-500 hover:text-blue-600 cursor-pointer transition-colors shrink-0"
            >
              Data Room
            </button>
            <span className="material-symbols-outlined text-[14px] text-slate-300 shrink-0">
              chevron_right
            </span>
            <span className="font-medium text-slate-900 truncate max-w-[120px]">
              {activeFolder.name}
            </span>
          </>
        ) : (
          <span className="font-medium text-slate-900 shrink-0">Data Room</span>
        )}
      </nav>
      <div className="flex items-center gap-3 shrink-0">
        {/* Team Members Avatar Group */}
        <div className="flex items-center -space-x-2" title="Team members with access">
          {teamMembers.slice(0, 3).map((member, idx) => {
            const user = member.user;
            return user?.avatar ? (
              <img
                key={member.id}
                src={user.avatar}
                alt={user.name || ""}
                title={`${user.name || "Unknown"} (${member.role})`}
                className="size-8 rounded-full border-2 border-white bg-slate-200 object-cover"
                style={{ zIndex: 3 - idx }}
              />
            ) : (
              <div
                key={member.id}
                className="flex size-8 items-center justify-center rounded-full border-2 border-white text-xs font-semibold"
                style={{ backgroundColor: "#E6EEF5", color: "#003366", zIndex: 3 - idx }}
                title={`${user?.name || "Unknown"} (${member.role})`}
              >
                {getInitials(user?.name || "")}
              </div>
            );
          })}
          {teamMembers.length > 3 && (
            <div className="flex size-8 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-xs font-bold text-slate-600">
              +{teamMembers.length - 3}
            </div>
          )}
          <button
            type="button"
            onClick={onManageTeam}
            title="Manage deal team"
            aria-label="Manage deal team"
            className="flex size-8 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">group_add</span>
          </button>
        </div>
        <div className="h-4 w-px bg-slate-200 mx-2" />
        <button
          type="button"
          onClick={handleUpload}
          disabled={uploading || !activeFolderId}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white shadow transition-colors disabled:opacity-50"
          style={{ backgroundColor: "#003366" }}
        >
          {uploading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
              Uploading...
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-[18px]">cloud_upload</span>
              Upload Files
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.xlsx,.xls,.doc,.docx"
          onChange={onFilesSelected}
          className="hidden"
        />
      </div>
    </header>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Upload Confirmation Modal (two-stage upload matching legacy)         */
/* ────────────────────────────────────────────────────────────────────── */

interface UploadConfirmModalProps {
  /** Selected files that won't be uploaded, and why. */
  skipped?: { name: string; reason: string }[];
  files: File[];
  autoUpdateDeal: boolean;
  uploading: boolean;
  onAutoUpdateChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UploadConfirmModal({
  files,
  skipped = [],
  autoUpdateDeal,
  uploading,
  onAutoUpdateChange,
  onConfirm,
  onCancel,
}: UploadConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">
            Upload {files.length} file{files.length > 1 ? "s" : ""}
          </h3>
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-600">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div className="p-4">
          {skipped.length > 0 && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
              <p className="font-medium">
                {skipped.length} file{skipped.length > 1 ? "s" : ""} won&apos;t be uploaded:
              </p>
              <ul className="mt-1 space-y-0.5">
                {skipped.map((f) => (
                  <li key={f.name} className="truncate">{f.name}: {f.reason}</li>
                ))}
              </ul>
            </div>
          )}
          <ul className="mb-4 space-y-1.5 max-h-40 overflow-y-auto">
            {files.map((f, i) => (
              <li key={i} className="text-sm text-slate-600 flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px] text-slate-400">description</span>
                <span className="truncate">{f.name}</span>
                <span className="text-xs text-slate-400 shrink-0">
                  ({(f.size / 1024 / 1024).toFixed(1)} MB)
                </span>
              </li>
            ))}
          </ul>
          {files.some((f) => f.type === "application/pdf") && (
            <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
              <input
                type="checkbox"
                checked={autoUpdateDeal}
                onChange={(e) => onAutoUpdateChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Auto-update deal with extracted data
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Merge financial data (revenue, EBITDA, industry) from PDF into the deal card
                </div>
              </div>
            </label>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 p-4 border-t border-slate-200">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={uploading}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50"
            style={{ backgroundColor: "#003366" }}
          >
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Link to Deal Modal                                                   */
/* ────────────────────────────────────────────────────────────────────── */

interface LinkToDealModalProps {
  file: VDRFile;
  deals: Array<{ id: string; name: string; industry?: string }>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  linking: boolean;
  onSelect: (dealId: string) => void;
  onClose: () => void;
}

export function LinkToDealModal({
  file,
  deals,
  searchQuery,
  onSearchChange,
  linking,
  onSelect,
  onClose,
}: LinkToDealModalProps) {
  const filtered = deals.filter(
    (d) => !searchQuery || d.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Link to Deal</h3>
            <p className="text-xs text-slate-500 mt-0.5 truncate">&quot;{file.name}&quot;</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
        <div className="p-4">
          <input
            type="text"
            placeholder="Search deals..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
            autoFocus
          />
          <ul className="max-h-60 overflow-y-auto space-y-1">
            {filtered.map((deal) => (
              <li key={deal.id}>
                <button
                  type="button"
                  onClick={() => onSelect(deal.id)}
                  disabled={linking}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[20px] text-slate-400">
                    business_center
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{deal.name}</div>
                    {deal.industry && <div className="text-xs text-slate-500">{deal.industry}</div>}
                  </div>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="text-sm text-slate-400 text-center py-4">No deals found</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

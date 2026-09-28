"use client";

import { useEffect, useRef, useState } from "react";
import type { VDRFile } from "@/lib/vdr/types";

interface Props {
  files: VDRFile[];
  folderName?: string;
  onFileClick?: (file: VDRFile) => void;
  onDeleteFile?: (fileId: string) => void;
  onRenameFile?: (fileId: string, newName: string) => void;
  onLinkToDeal?: (file: VDRFile) => void;
  onExtractFinancials?: (file: VDRFile) => void;
  onReanalyze?: (file: VDRFile) => void;
}

const FILE_ICON: Record<string, string> = {
  excel: "table_view",
  pdf: "picture_as_pdf",
  doc: "description",
  other: "description",
};

const FILE_ICON_STYLE: Record<string, { bg: string; text: string }> = {
  excel: { bg: "bg-green-50", text: "text-green-600" },
  pdf: { bg: "bg-red-50", text: "text-red-600" },
  doc: { bg: "bg-blue-50", text: "text-blue-600" },
  other: { bg: "bg-slate-50", text: "text-slate-600" },
};

function getAnalysisStyle(type: string) {
  if (type === "key-insight" || type === "complete") {
    return { className: "text-primary", icon: "auto_awesome" };
  }
  if (type === "warning") {
    return { className: "text-orange-600", icon: "warning" };
  }
  if (type === "ready") {
    return { className: "text-green-600", icon: "check_circle" };
  }
  // "standard" = Pending Analysis — grey hourglass
  return { className: "text-slate-400", icon: "hourglass_top" };
}

export function FileTable({
  files,
  onFileClick,
  onDeleteFile,
  onRenameFile,
  onLinkToDeal,
  onExtractFinancials,
  onReanalyze,
}: Props) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (renamingFileId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingFileId]);

  const submitRename = (fileId: string) => {
    const original = files.find((f) => f.id === fileId)?.name;
    if (renameValue.trim() && renameValue !== original) {
      onRenameFile?.(fileId, renameValue.trim());
    }
    setRenamingFileId(null);
    setRenameValue("");
  };

  return (
    <div className="flex-1 overflow-auto px-6 py-4 custom-scrollbar">
      <div className="min-w-full inline-block align-middle">
        {/* No overflow-hidden here — it clips the row-action dropdown.
            Table corners use border-radius via children's first/last styling. */}
        <div className="border border-slate-200 rounded-lg bg-white shadow-sm">
          <table className="w-full table-fixed divide-y divide-slate-200">
            <thead className="bg-slate-50/80">
              <tr>
                <th className="py-3.5 pl-4 pr-3 text-left text-xs font-semibold text-slate-500 sm:pl-6" scope="col">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                      aria-label="Select all files"
                    />
                    Name
                  </div>
                </th>
                <th className="px-3 py-3.5 text-left text-xs font-semibold text-slate-500 w-[30%]" scope="col">
                  AI Analysis
                </th>
                <th
                  className="hidden xl:table-cell px-3 py-3.5 text-left text-xs font-semibold text-slate-500 w-32"
                  scope="col"
                >
                  Author
                </th>
                <th className="px-3 py-3.5 text-left text-xs font-semibold text-slate-500 w-28" scope="col">
                  Date
                </th>
                <th className="relative w-16 py-3.5 pl-3 pr-4 sm:pr-6" scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {files.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center">
                    <span className="material-symbols-outlined text-4xl text-slate-300 mb-2 block">
                      folder_open
                    </span>
                    <p className="text-sm text-slate-500">No files in this folder yet</p>
                    <p className="text-xs text-slate-400 mt-1">Upload files to get started</p>
                  </td>
                </tr>
              ) : (
                files.map((file) => {
                  const iconStyle = FILE_ICON_STYLE[file.type] || FILE_ICON_STYLE.other;
                  const analysisStyle = getAnalysisStyle(file.analysis.type);
                  return (
                    <tr
                      key={file.id}
                      className={`group hover:bg-slate-50 transition-colors cursor-pointer ${
                        file.isHighlighted ? "bg-primary/5" : ""
                      }`}
                      onClick={() => onFileClick?.(file)}
                    >
                      <td
                        className={`py-4 pl-4 pr-3 text-sm sm:pl-6 ${
                          file.isHighlighted ? "border-l-4 border-l-primary" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`flex size-10 shrink-0 items-center justify-center rounded ${iconStyle.bg}`}
                          >
                            <span className={`material-symbols-outlined ${iconStyle.text}`}>
                              {FILE_ICON[file.type] || FILE_ICON.other}
                            </span>
                          </div>
                          <div className="flex flex-col min-w-0">
                            {renamingFileId === file.id ? (
                              <input
                                ref={renameInputRef}
                                type="text"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    submitRename(file.id);
                                  } else if (e.key === "Escape") {
                                    setRenamingFileId(null);
                                    setRenameValue("");
                                  }
                                }}
                                onBlur={() => submitRename(file.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="font-medium text-slate-900 px-2 py-1 border border-primary rounded focus:outline-none focus:ring-2 focus:ring-primary/20 min-w-[200px]"
                              />
                            ) : (
                              <div
                                className="font-medium text-slate-900 group-hover:text-primary transition-colors truncate"
                                title={file.name}
                              >
                                {file.name}
                              </div>
                            )}
                            <div className="flex items-center gap-1.5 text-xs text-slate-400">
                              <span>{file.size}</span>
                              {file.docType && file.docType !== "OTHER" && (
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                  {file.docType}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-4 text-sm text-slate-500">
                        <div className="flex flex-col gap-1">
                          <div className={`flex items-center gap-1.5 text-xs font-medium ${analysisStyle.className}`}>
                            <span className="material-symbols-outlined text-[14px]">
                              {analysisStyle.icon}
                            </span>
                            {file.analysis.label}
                          </div>
                          <p
                            className="text-xs leading-relaxed text-slate-600 line-clamp-2"
                            title={file.analysis.description}
                          >
                            {file.analysis.description}
                          </p>
                          {file.analysis.type === "standard" && onReanalyze && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onReanalyze(file);
                              }}
                              className="mt-1 inline-flex items-center gap-1 text-xs font-medium rounded px-2 py-1 transition-colors hover:bg-slate-100 self-start"
                              style={{ color: "#003366" }}
                            >
                              <span className="material-symbols-outlined text-[14px]">refresh</span>
                              Re-analyze
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="hidden xl:table-cell whitespace-nowrap px-3 py-4 text-sm text-slate-500">
                        <div className="flex items-center gap-2">
                          <div
                            className="size-6 rounded-full bg-cover bg-slate-200 flex items-center justify-center text-[10px] font-semibold text-slate-600"
                            style={
                              file.author.avatar
                                ? { backgroundImage: `url('${encodeURI(file.author.avatar)}')` }
                                : undefined
                            }
                            aria-label={file.author.name}
                          >
                            {!file.author.avatar &&
                              file.author.name
                                .split(" ")
                                .map((n) => n[0])
                                .join("")
                                .slice(0, 2)
                                .toUpperCase()}
                          </div>
                          <span className="text-xs">{file.author.name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-xs text-slate-500">
                        {file.date}
                      </td>
                      <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                        <div className="relative inline-block" ref={openMenuId === file.id ? menuRef : null}>
                          <button
                            type="button"
                            className="text-slate-400 hover:text-primary transition-colors p-1 rounded hover:bg-slate-100"
                            aria-label="More options"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(openMenuId === file.id ? null : file.id);
                            }}
                          >
                            <span className="material-symbols-outlined">more_vert</span>
                          </button>
                          {openMenuId === file.id && (
                            <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-[60]">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingFileId(file.id);
                                  setRenameValue(file.name);
                                  setOpenMenuId(null);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                              >
                                <span className="material-symbols-outlined text-[18px]">edit</span>
                                Rename
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onFileClick?.(file);
                                  setOpenMenuId(null);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                              >
                                <span className="material-symbols-outlined text-[18px]">download</span>
                                Download
                              </button>
                              {onLinkToDeal && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onLinkToDeal(file);
                                    setOpenMenuId(null);
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                                >
                                  <span className="material-symbols-outlined text-[18px]">link</span>
                                  Link to Deal
                                </button>
                              )}
                              {onExtractFinancials && (file.type === "excel" || file.type === "pdf") && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onExtractFinancials(file);
                                    setOpenMenuId(null);
                                  }}
                                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                                >
                                  <span className="material-symbols-outlined text-[18px]">analytics</span>
                                  Extract Financials
                                </button>
                              )}
                              <div className="border-t border-slate-200 my-1" />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteFile?.(file.id);
                                  setOpenMenuId(null);
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                              >
                                <span className="material-symbols-outlined text-[18px]">delete</span>
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

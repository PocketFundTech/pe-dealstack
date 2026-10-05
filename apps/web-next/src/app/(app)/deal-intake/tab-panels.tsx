"use client";

import { type RefObject } from "react";
import { formatFileSize } from "@/lib/formatters";
import { cn } from "@/lib/cn";
import { TEXT_SOURCE_TYPES } from "./components";

/* ------------------------------------------------------------------ */
/*  FileUploadPanel                                                     */
/* ------------------------------------------------------------------ */

export interface FileUploadItem {
  file: File;
  status: "pending" | "uploading" | "done" | "failed";
  message?: string;
}

interface FileUploadPanelProps {
  files: FileUploadItem[];
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (index: number) => void;
  onClearAll: () => void;
  onUpload: () => void;
  onUploadDirect?: () => void;
  processing: boolean;
  actionLabel: string;
  showDirectUpload: boolean;
  directUploadDisabled: boolean;
}

export function FileUploadPanel({
  files, dragOver, setDragOver, fileInputRef, onDrop, onFileSelect,
  onRemoveFile, onClearAll, onUpload, onUploadDirect, processing, actionLabel,
  showDirectUpload, directUploadDisabled,
}: FileUploadPanelProps) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-6 shadow-card">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 hover:border-primary/50 hover:bg-primary-light/30 transition-all cursor-pointer",
          dragOver ? "border-primary bg-primary-light/50" : "border-border-subtle"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="absolute inset-0 opacity-0 cursor-pointer"
          accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.csv"
          onChange={onFileSelect}
        />
        <span className="material-symbols-outlined text-4xl text-text-muted">cloud_upload</span>
        <div className="text-center">
          <p className="text-sm font-medium text-text-main">
            Drag & drop files here, or <span className="text-primary font-semibold">browse</span>
          </p>
          <p className="text-xs text-text-muted mt-1">
            PDF, Word (.docx, .doc), Excel (.xlsx), or Text (.txt) -- Max 50MB each -- multiple files supported
          </p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {files.map((item, index) => (
            <div key={`${item.file.name}-${index}`} className="flex items-center gap-3 rounded-lg bg-primary-light/50 border border-primary/20 px-4 py-3">
              <span className="material-symbols-outlined text-primary">description</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-main truncate">{item.file.name}</p>
                <p className="text-xs text-text-muted">{formatFileSize(item.file.size)}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onRemoveFile(index); }}
                disabled={processing}
                className="p-1 rounded hover:bg-white/50 text-text-muted hover:text-red-500 transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
          ))}
          {files.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); onClearAll(); }}
              disabled={processing}
              className="self-end text-xs text-text-muted hover:text-red-500 disabled:opacity-50 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      <button
        onClick={onUpload}
        disabled={files.length === 0 || processing}
        className="mt-4 w-full py-2.5 px-4 rounded-lg text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
        Extract & {actionLabel}{files.length > 1 ? ` (${files.length} files)` : ""}
      </button>

      {showDirectUpload && (
        <button
          onClick={onUploadDirect}
          disabled={directUploadDisabled}
          className="mt-2 w-full py-2.5 px-4 rounded-lg border border-border-subtle text-text-secondary text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-[18px]">upload_file</span>
          Upload to Data Room Only
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  UploadProgressList — per-file status rows shown while a multi-file  */
/*  batch is processing (extracted from IngestDealForm's loading state  */
/*  to keep that component under the file-size cap).                    */
/* ------------------------------------------------------------------ */

interface UploadProgressListProps {
  files: FileUploadItem[];
}

export function UploadProgressList({ files }: UploadProgressListProps) {
  return (
    <div className="mt-5 flex flex-col gap-1.5 text-left">
      {files.map((f, i) => (
        <div key={`${f.file.name}-${i}`} className="flex items-center gap-2 rounded-md bg-white/60 px-3 py-2">
          <span
            className={cn(
              "material-symbols-outlined text-[16px] shrink-0",
              f.status === "done" && "text-emerald-600",
              f.status === "failed" && "text-red-500",
              f.status === "uploading" && "text-primary animate-spin",
              f.status === "pending" && "text-text-muted",
            )}
          >
            {f.status === "done" ? "check_circle" : f.status === "failed" ? "error" : f.status === "uploading" ? "progress_activity" : "schedule"}
          </span>
          <span className="flex-1 min-w-0 truncate text-xs text-text-main">{f.file.name}</span>
          {f.status === "failed" && f.message && (
            <span className="text-[11px] text-red-600 truncate max-w-[45%]" title={f.message}>{f.message}</span>
          )}
          {f.status === "uploading" && f.message && (
            <span className="text-[11px] text-text-muted truncate max-w-[45%]">{f.message}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  TextInputPanel                                                      */
/* ------------------------------------------------------------------ */

interface TextInputPanelProps {
  textInput: string;
  setTextInput: (v: string) => void;
  textSourceType: string;
  setTextSourceType: (v: string) => void;
  onExtract: () => void;
  processing: boolean;
  actionLabel: string;
}

export function TextInputPanel({
  textInput, setTextInput, textSourceType, setTextSourceType,
  onExtract, processing, actionLabel,
}: TextInputPanelProps) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-6 shadow-card">
      <label className="block text-sm font-medium text-text-main mb-2">Paste deal information</label>
      <textarea
        value={textInput}
        onChange={(e) => setTextInput(e.target.value)}
        rows={10}
        className="w-full rounded-lg border border-border-subtle bg-white px-4 py-3 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
        placeholder={"Paste deal memo, email, CIM summary, or any text containing company and financial information...\n\nExample:\nAcme Healthcare Services is a leading home healthcare provider in the Northeast US with $150M revenue and $30M EBITDA..."}
      />
      <div className="flex items-center justify-between mt-2">
        <p className="text-xs text-text-muted">
          <span>{textInput.length}</span> characters (minimum 50)
        </p>
        <select
          value={textSourceType}
          onChange={(e) => setTextSourceType(e.target.value)}
          className="rounded-md border border-border-subtle bg-white px-3 py-1.5 text-xs text-text-secondary focus:border-primary focus:ring-1 focus:ring-primary/30"
        >
          {TEXT_SOURCE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>

      <button
        onClick={onExtract}
        disabled={textInput.trim().length < 50 || processing}
        className="mt-4 w-full py-2.5 px-4 rounded-lg text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
        Extract & {actionLabel}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  UrlInputPanel                                                       */
/* ------------------------------------------------------------------ */

interface UrlInputPanelProps {
  urlInput: string;
  setUrlInput: (v: string) => void;
  urlCompanyName: string;
  setUrlCompanyName: (v: string) => void;
  onExtract: () => void;
  processing: boolean;
  isValidUrl: boolean;
  actionLabel: string;
}

export function UrlInputPanel({
  urlInput, setUrlInput, urlCompanyName, setUrlCompanyName,
  onExtract, processing, isValidUrl, actionLabel,
}: UrlInputPanelProps) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-card p-6 shadow-card">
      <label className="block text-sm font-medium text-text-main mb-2">Company website URL</label>
      <div className="relative">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">link</span>
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          className="w-full rounded-lg border border-border-subtle bg-white pl-10 pr-4 py-2.5 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20 transition-colors"
          placeholder="https://www.example.com"
        />
      </div>

      <label className="block text-sm font-medium text-text-main mt-4 mb-2">
        Company name <span className="text-text-muted font-normal">(optional override)</span>
      </label>
      <input
        type="text"
        value={urlCompanyName}
        onChange={(e) => setUrlCompanyName(e.target.value)}
        className="w-full rounded-lg border border-border-subtle bg-white px-4 py-2.5 text-sm text-text-main placeholder-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20 transition-colors"
        placeholder="e.g. Acme Healthcare"
      />

      <button
        onClick={onExtract}
        disabled={!isValidUrl || processing}
        className="mt-4 w-full py-2.5 px-4 rounded-lg text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
        style={{ backgroundColor: "#003366" }}
      >
        <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
        Scrape & {actionLabel}
      </button>
    </div>
  );
}

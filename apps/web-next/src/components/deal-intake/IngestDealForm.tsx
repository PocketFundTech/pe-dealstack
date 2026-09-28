"use client";

// ---------------------------------------------------------------------------
// IngestDealForm — extracted from app/(app)/deal-intake/page.tsx so the same
// upload + extraction + follow-up flow can be rendered both:
//   - as a full-page route (/deal-intake), and
//   - as the body of the IngestDealModal popup opened from the header,
//     command palette, dashboard quick actions, and deals page.
//
// All form state, API wiring, and validation matches the legacy full-page
// version 1:1 — only the surrounding chrome (page heading vs. modal header)
// is conditional via the `variant` prop. The `onClose` callback fires after a
// successful "View Deal" navigation so the modal can dismiss itself.
// ---------------------------------------------------------------------------

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import {
  type DealOption,
  type IngestResponse,
  type TabKey,
  type FollowUpQuestion,
  MAX_FILE_SIZE,
  TABS,
  authFetchRaw,
  DealSelector,
  ResultDisplay,
} from "@/app/(app)/deal-intake/components";
import { FollowUpQuestions, WarningBanner } from "@/app/(app)/deal-intake/intake-widgets";
import { FileUploadPanel, TextInputPanel, type FileUploadItem } from "@/app/(app)/deal-intake/tab-panels";
import { DealTeaserPopup } from "@/app/(app)/deal-intake/DealTeaserPopup";
import type { DealTeaser } from "@/lib/teaser";
import {
  pickGoogleFile,
  preloadGooglePicker,
  isGooglePickerConfigured,
} from "@/lib/googlePicker";
import { emitDealsChanged } from "@/lib/appEvents";
import { planFileUpload, resolveDealFromResponse } from "@/components/deal-intake/batchPlan";

// Drive MIME allow-list for ingest — mirrors the multipart upload's accepted
// types plus native Google Docs/Sheets (exported server-side to PDF/XLSX).
const DRIVE_INGEST_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
];

interface IngestDealFormProps {
  /** "page" renders the standalone /deal-intake page chrome (heading + outer scroll
   *  wrapper). "modal" omits those — the IngestDealModal supplies its own header
   *  and scroll container. */
  variant?: "page" | "modal";
  /** Called when the user finishes (e.g. after navigating to the new deal). The
   *  modal uses this to close itself; the page route ignores it. */
  onClose?: () => void;
  /** When set, the form opens directly in "Update Existing Deal" mode with
   *  this deal pre-selected (e.g. opened from a deal's own page/menu so the
   *  user doesn't have to re-search for the deal they're already on). */
  preselectedDeal?: DealOption | null;
}

export function IngestDealForm({ variant = "page", onClose, preselectedDeal = null }: IngestDealFormProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("file");

  /* ---- Deal selector ---- */
  const [mode, setMode] = useState<"new" | "existing">(preselectedDeal ? "existing" : "new");
  const [dealSearch, setDealSearch] = useState("");
  const [dealOptions, setDealOptions] = useState<DealOption[]>([]);
  const [selectedDeal, setSelectedDeal] = useState<DealOption | null>(preselectedDeal);
  const [loadingDeals, setLoadingDeals] = useState(false);
  const [showDealDropdown, setShowDealDropdown] = useState(false);

  /* ---- File upload ---- */
  const [files, setFiles] = useState<FileUploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---- Text ---- */
  const [textInput, setTextInput] = useState("");
  const [textSourceType, setTextSourceType] = useState("other");

  /* ---- Processing ---- */
  const [processing, setProcessing] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");

  /* ---- Result ---- */
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ title: string; message: string } | null>(null);

  /* ---- Firm-teaser popup (firm-criteria fit, shown right after create) ---- */
  const [teaserPopup, setTeaserPopup] = useState<{
    deal: { id: string; name: string };
    teasers: DealTeaser[];
  } | null>(null);

  /* ---- Follow-up questions ---- */
  const [followUpQuestions, setFollowUpQuestions] = useState<FollowUpQuestion[]>([]);
  const [followUpAnswers, setFollowUpAnswers] = useState<Record<string, string>>({});
  const [followUpLoading, setFollowUpLoading] = useState(false);

  /* ================================================================ */
  /*  Deal search                                                      */
  /* ================================================================ */

  const searchDeals = useCallback(async (query: string) => {
    if (query.length < 2) { setDealOptions([]); return; }
    setLoadingDeals(true);
    try {
      const res = await api.get<DealOption[] | { deals: DealOption[] }>(`/deals?search=${encodeURIComponent(query)}&limit=10`);
      setDealOptions(Array.isArray(res) ? res.slice(0, 10) : (res?.deals ?? []));
    } catch (err) {
      console.warn("[deal-intake] searchDeals failed:", err);
      setDealOptions([]);
    }
    finally { setLoadingDeals(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (dealSearch) searchDeals(dealSearch); }, 300);
    return () => clearTimeout(timer);
  }, [dealSearch, searchDeals]);

  // Warm the Google Picker SDKs so the popup opens reliably on first click.
  useEffect(() => { preloadGooglePicker(); }, []);

  useEffect(() => {
    if (!showDealDropdown) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-deal-dropdown]")) setShowDealDropdown(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showDealDropdown]);

  /* ================================================================ */
  /*  File handling                                                     */
  /* ================================================================ */

  const addFiles = (incoming: FileList | File[]) => {
    setWarning(null);
    const oversized: string[] = [];
    const accepted: File[] = [];
    Array.from(incoming).forEach((file) => {
      if (file.size > MAX_FILE_SIZE) oversized.push(file.name);
      else accepted.push(file);
    });
    if (oversized.length > 0) {
      setWarning({
        title: "File too large",
        message: `${oversized.join(", ")} exceed${oversized.length === 1 ? "s" : ""} the maximum upload size of 50MB and ${oversized.length === 1 ? "was" : "were"} skipped.`,
      });
    }
    if (accepted.length > 0) {
      setFiles((prev) => [...prev, ...accepted.map((file) => ({ file, status: "pending" as const }))]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    // Allow re-selecting the same file(s) after removal.
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const clearFiles = () => {
    setFiles([]); setWarning(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  /* ================================================================ */
  /*  Follow-up questions                                              */
  /* ================================================================ */

  const fetchFollowUpQuestions = useCallback(async (dealId: string, extraction: IngestResponse["extraction"]) => {
    if (!extraction) return;
    setFollowUpLoading(true);
    try {
      const res = await api.post<{ questions: FollowUpQuestion[] }>(`/deals/${dealId}/follow-up-questions`, {
        extraction: {
          companyName: extraction.companyName?.value || null,
          industry: extraction.industry?.value || null,
          revenue: extraction.revenue?.value || null,
          ebitda: extraction.ebitda?.value || null,
          currency: extraction.currency || "USD",
          summary: extraction.summary || null,
          keyRisks: extraction.keyRisks || [],
          investmentHighlights: extraction.investmentHighlights || [],
          overallConfidence: extraction.overallConfidence || 0,
        },
      });
      setFollowUpQuestions(res.questions || []);
    } catch (err) {
      console.warn("[deal-intake] fetchFollowUpQuestions failed:", err);
    }
    finally { setFollowUpLoading(false); }
  }, []);

  const handleFollowUpAnswer = (questionId: string, answer: string) => {
    setFollowUpAnswers((prev) => {
      const next = { ...prev };
      if (answer.trim()) next[questionId] = answer; else delete next[questionId];
      return next;
    });
  };

  /* ================================================================ */
  /*  Submission handlers                                              */
  /* ================================================================ */

  const actionLabel = mode === "existing" ? "Update Deal" : "Create Deal";

  const clearState = () => {
    setError(null); setResult(null); setFollowUpQuestions([]); setFollowUpAnswers({});
  };

  const resetForm = () => {
    setFiles([]); setTextInput("");
    setWarning(null); clearState();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 503 AI_PROVIDER_UNAVAILABLE means the AI provider (not the document)
  // rejected the request — surface that message as-is instead of the generic
  // "no deal information found" wording.
  const parseErrorMessage = (data: unknown): string => {
    const d = data as { code?: string; error?: string; message?: string };
    if (d?.code === "AI_PROVIDER_UNAVAILABLE" && d.error) return d.error;
    return d?.message || d?.error || "Upload failed";
  };

  const beginProcessing = (msg: string) => {
    setProcessing(true); setProgressMessage(msg); clearState();
  };

  const endProcessing = () => {
    setProcessing(false); setProgressMessage("");
  };

  const fireFollowUp = (data: IngestResponse) => {
    if (data.deal?.id && data.extraction) {
      setTimeout(() => fetchFollowUpQuestions(data.deal!.id, data.extraction), 800);
    }
  };

  // After a NEW deal is created, surface its firm-criteria teaser as a popup.
  // Teasers are generated server-side during ingest (blocking), so they're
  // ready by the time we get here. No profiles configured -> empty list ->
  // skip the popup silently. The deal is already created either way.
  const maybeShowTeaserPopup = useCallback(async (deal: { id: string; name: string }) => {
    try {
      const { teasers } = await api.get<{ teasers: DealTeaser[] }>(`/deals/${deal.id}/teasers`);
      if (teasers && teasers.length > 0) setTeaserPopup({ deal, teasers });
    } catch (err) {
      // Endpoint not live / no teasers — non-fatal, just don't pop up.
      console.warn("[deal-intake] teaser popup fetch failed:", err);
    }
  }, []);

  // Uploads every selected file sequentially. In "new" mode the FIRST file
  // creates the deal (via /ingest or /ingest/bulk for spreadsheets); every
  // subsequent file is attached to that same deal via /ingest + dealId. In
  // "existing" mode every file is attached to the selected deal. One file
  // failing doesn't abort the rest of the batch — each file gets its own
  // pending/uploading/done/failed status.
  const handleUploadFiles = async () => {
    if (files.length === 0) return;
    if (mode === "existing" && !selectedDeal) { setError("Please select a deal first."); return; }

    beginProcessing("Extracting deal data...");
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" as const, message: undefined })));

    let createdDealId: string | null = null;
    let createdDealName: string | null = null;
    let stopReason: string | null = null;
    let lastSuccessResult: IngestResponse | null = null;
    let anySucceeded = false;

    for (let i = 0; i < files.length; i++) {
      if (stopReason) {
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: stopReason! } : f)));
        continue;
      }

      const current = files[i];
      setProgressMessage(files.length > 1 ? `Processing ${current.file.name} (${i + 1}/${files.length})...` : "Extracting deal data...");
      setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "uploading" } : f)));

      const plan = planFileUpload({
        fileName: current.file.name,
        index: i,
        mode,
        selectedDealId: selectedDeal?.id ?? null,
        createdDealId,
      });

      try {
        const formData = new FormData();
        formData.append("file", current.file);
        if (plan.dealId) formData.append("dealId", plan.dealId);
        const response = await authFetchRaw(plan.endpoint, { method: "POST", body: formData });

        if (response.status === 413) {
          setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: "Maximum upload size is 50MB." } : f)));
          continue;
        }

        const data: IngestResponse = await response.json();
        if (!response.ok) {
          setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: parseErrorMessage(data) } : f)));
          continue;
        }

        anySucceeded = true;
        lastSuccessResult = data;
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "done" } : f)));
        emitDealsChanged({ dealId: data.deal?.id, source: "ingest-upload" });
        fireFollowUp(data);

        if (mode === "new" && i === 0) {
          const resolved = resolveDealFromResponse(data);
          if (resolved.multipleDeals) {
            stopReason = "Skipped — the first file created several deals. Add this document via \"Update Existing Deal\" once you know which one it belongs to.";
          } else if (resolved.dealId) {
            createdDealId = resolved.dealId;
            createdDealName = resolved.dealName;
          }
        }
      } catch (err) {
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: err instanceof Error ? err.message : "Upload failed" } : f)));
      }
    }

    endProcessing();

    if (stopReason) {
      setWarning({
        title: "Multiple deals created",
        message: "The first file created several deals, so the remaining files weren't attached to any of them. Use \"Update Existing Deal\" to add them once you've picked the right deal.",
      });
    }

    if (!anySucceeded) {
      setError(files.length > 1 ? "All uploads failed. See the status next to each file above." : "Upload failed");
      return;
    }

    if (lastSuccessResult) {
      setResult(lastSuccessResult);
      if (mode === "new" && createdDealId) {
        maybeShowTeaserPopup({ id: createdDealId, name: createdDealName || lastSuccessResult.deal?.name || "" });
      }
    }
  };

  const handleUploadDirect = async () => {
    if (files.length === 0 || !selectedDeal) return;
    beginProcessing("Uploading to Data Room...");
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" as const, message: undefined })));

    let anySucceeded = false;
    for (let i = 0; i < files.length; i++) {
      const current = files[i];
      setProgressMessage(files.length > 1 ? `Uploading ${current.file.name} (${i + 1}/${files.length})...` : "Uploading to Data Room...");
      setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "uploading" } : f)));
      try {
        const formData = new FormData();
        formData.append("file", current.file);
        const response = await authFetchRaw(`/deals/${selectedDeal.id}/documents`, { method: "POST", body: formData });
        const data = await response.json();
        if (!response.ok) {
          setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: parseErrorMessage(data) } : f)));
          continue;
        }
        anySucceeded = true;
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "done" } : f)));
      } catch (err) {
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: err instanceof Error ? err.message : "Upload failed" } : f)));
      }
    }

    endProcessing();
    if (anySucceeded) {
      setResult({ deal: { id: selectedDeal.id, name: selectedDeal.name }, isUpdate: true });
      emitDealsChanged({ dealId: selectedDeal.id, source: "ingest-direct-upload" });
    } else {
      setError(files.length > 1 ? "All uploads failed. See the status next to each file above." : "Upload failed");
    }
  };

  // Import a file straight from the user's Google Drive via the Picker, then
  // run it through the same /ingest pipeline as an upload. Works for any
  // connected Google account (personal or Workspace).
  const handlePickGoogleDrive = async () => {
    if (mode === "existing" && !selectedDeal) { setError("Please select a deal first."); return; }
    let picked;
    try {
      picked = await pickGoogleFile({
        mimeTypes: DRIVE_INGEST_MIME_TYPES,
        title: "Select a file from Google Drive",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google Drive picker failed");
      return;
    }
    if (!picked) return; // user cancelled the picker
    beginProcessing("Importing from Google Drive...");
    try {
      const body: Record<string, string> = { fileId: picked.fileId };
      if (mode === "existing" && selectedDeal) body.dealId = selectedDeal.id;
      const data = await api.post<IngestResponse>("/ingest/drive", body);
      setResult(data);
      // Refresh any open list/data-room surface so the Drive-imported deal or
      // document appears without a manual reload.
      emitDealsChanged({ dealId: data.deal?.id, source: "ingest-drive" });
      fireFollowUp(data);
      if (mode === "new" && data.deal?.id) {
        maybeShowTeaserPopup({ id: data.deal.id, name: data.deal.name });
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Drive import failed"); }
    finally { endProcessing(); }
  };

  const handleExtractText = async () => {
    if (textInput.trim().length < 50) { setError("Please enter at least 50 characters of text."); return; }
    if (mode === "existing" && !selectedDeal) { setError("Please select a deal first."); return; }
    beginProcessing("Extracting deal data...");
    try {
      const body: Record<string, string> = { text: textInput, sourceType: textSourceType };
      if (mode === "existing" && selectedDeal) body.dealId = selectedDeal.id;
      const data = await api.post<IngestResponse>("/ingest/text", body);
      setResult(data);
      emitDealsChanged({ dealId: data.deal?.id, source: "ingest-text" });
      fireFollowUp(data);
      if (mode === "new" && data.deal?.id) {
        maybeShowTeaserPopup({ id: data.deal.id, name: data.deal.name });
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Text extraction failed"); }
    finally { endProcessing(); }
  };

  const handleSaveFollowUpAndGoToDeal = async () => {
    if (!result?.deal?.id || Object.keys(followUpAnswers).length === 0) return;
    try {
      await api.patch(`/deals/${result.deal.id}`, {
        customFields: { aiFollowUp: { generatedAt: new Date().toISOString(), questions: followUpQuestions, answers: followUpAnswers } },
      });
    } catch (err) {
      console.warn("[deal-intake] save follow-up answers failed:", err);
    }
    // Close modal (if any) before navigating so the overlay doesn't flash
    // briefly over the destination page.
    onClose?.();
    window.location.href = `/deals/${result.deal.id}`;
  };

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  // Inner content shared between page/modal variants. The modal supplies its
  // own outer wrapper (overflow + padding) so we only render the column here.
  const inner = (
    <div className={cn("mx-auto max-w-3xl flex flex-col gap-6", variant === "modal" && "max-w-none")}>
      {variant === "page" && (
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">Deal Intake</h1>
          <p className="text-text-secondary text-sm">Upload a document or paste text to create a new deal.</p>
        </div>
      )}

      {/* Deal mode selector */}
      <DealSelector
        mode={mode}
        setMode={setMode}
        selectedDeal={selectedDeal}
        setSelectedDeal={setSelectedDeal}
        dealSearch={dealSearch}
        setDealSearch={setDealSearch}
        dealOptions={dealOptions}
        loadingDeals={loadingDeals}
        showDealDropdown={showDealDropdown}
        setShowDealDropdown={setShowDealDropdown}
      />

      {/* Tab switcher */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); clearState(); }}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-md text-sm font-medium transition-all",
              activeTab === tab.key ? "bg-white text-primary shadow-sm" : "text-text-secondary hover:text-text-main",
            )}
          >
            <span className="material-symbols-outlined text-[18px]">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!processing && !result && (
        <>
          {activeTab === "file" && (
            <div className="flex flex-col gap-4">
              <FileUploadPanel
                files={files}
                dragOver={dragOver}
                setDragOver={setDragOver}
                fileInputRef={fileInputRef}
                onDrop={handleDrop}
                onFileSelect={handleFileSelect}
                onRemoveFile={removeFile}
                onClearAll={clearFiles}
                onUpload={handleUploadFiles}
                onUploadDirect={handleUploadDirect}
                processing={processing}
                actionLabel={actionLabel}
                showDirectUpload={mode === "existing"}
                directUploadDisabled={files.length === 0 || !selectedDeal || processing}
              />
              {isGooglePickerConfigured && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border-subtle" />
                    <span className="text-xs text-text-muted">or</span>
                    <div className="h-px flex-1 bg-border-subtle" />
                  </div>
                  <button
                    type="button"
                    onClick={handlePickGoogleDrive}
                    disabled={processing || (mode === "existing" && !selectedDeal)}
                    className="flex items-center justify-center gap-2 rounded-lg border border-border-subtle bg-white px-4 py-2.5 text-sm font-medium text-text-secondary hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">add_to_drive</span>
                    Import from Google Drive
                  </button>
                </>
              )}
            </div>
          )}
          {activeTab === "text" && (
            <TextInputPanel
              textInput={textInput}
              setTextInput={setTextInput}
              textSourceType={textSourceType}
              setTextSourceType={setTextSourceType}
              onExtract={handleExtractText}
              processing={processing}
              actionLabel={actionLabel}
            />
          )}
        </>
      )}

      {/* Loading state */}
      {processing && (
        <div className="rounded-lg border border-primary/20 bg-primary-light/30 p-8 shadow-card text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
            <span className="material-symbols-outlined text-primary text-2xl animate-spin">progress_activity</span>
          </div>
          <p className="text-sm font-medium text-text-main">{progressMessage || "Extracting deal data..."}</p>
          <p className="text-xs text-text-secondary mt-1">AI is analyzing the content and extracting company information</p>

          {activeTab === "file" && files.length > 1 && (
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
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Warning */}
      {warning && <WarningBanner title={warning.title} message={warning.message} onDismiss={() => setWarning(null)} />}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-5 shadow-card">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-red-500 mt-0.5">error</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800">
                {activeTab === "text" ? "Text extraction failed" : "Upload failed"}
              </p>
              <p className="text-xs text-red-600 mt-1">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600 transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>
      )}

      {/* Result */}
      {result && (
        <div>
          <ResultDisplay result={result} onReset={resetForm} />
          {result.deal && (followUpLoading || followUpQuestions.length > 0) && (
            <div className="bg-surface-card rounded-lg border border-border-subtle shadow-card p-5 mt-4">
              <FollowUpQuestions
                questions={followUpQuestions}
                answers={followUpAnswers}
                onAnswer={handleFollowUpAnswer}
                loading={followUpLoading}
              />
              {Object.keys(followUpAnswers).length > 0 && (
                <div className="mt-5">
                  <button
                    onClick={handleSaveFollowUpAndGoToDeal}
                    className="w-full py-2.5 px-4 rounded-lg text-white text-sm font-medium hover:opacity-90 transition-all flex items-center justify-center gap-2"
                    style={{ backgroundColor: "#003366" }}
                  >
                    <span className="material-symbols-outlined text-[18px]">save</span>
                    Save & View Deal
                  </button>
                  <p className="text-center mt-2">
                    <button
                      onClick={() => {
                        if (result.deal) {
                          onClose?.();
                          window.location.href = `/deals/${result.deal.id}`;
                        }
                      }}
                      className="text-[11px] text-gray-400 hover:text-gray-600 cursor-pointer transition-colors"
                    >
                      Skip -- I&apos;ll add context later
                    </button>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {teaserPopup && (
        <DealTeaserPopup
          deal={teaserPopup.deal}
          teasers={teaserPopup.teasers}
          onClose={() => setTeaserPopup(null)}
          onViewDeal={() => {
            onClose?.();
            window.location.href = `/deals/${teaserPopup.deal.id}`;
          }}
          onRejected={() => {
            setTeaserPopup(null);
            resetForm();
          }}
        />
      )}
    </div>
  );

  if (variant === "modal") {
    // The modal shell handles its own padding/scroll; just return the column.
    return inner;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {inner}
    </div>
  );
}

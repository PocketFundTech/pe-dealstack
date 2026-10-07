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
  DealSelector,
} from "@/app/(app)/deal-intake/components";
import { ResultWithFollowUp, WarningBanner } from "@/app/(app)/deal-intake/intake-widgets";
import { FileUploadPanel, TextInputPanel, UploadProgressList, type FileUploadItem } from "@/app/(app)/deal-intake/tab-panels";
import { DealTeaserPopup } from "@/app/(app)/deal-intake/DealTeaserPopup";
import type { DealTeaser } from "@/lib/teaser";
import { preloadGooglePicker, isGooglePickerConfigured } from "@/lib/googlePicker";
import { pollTeasers } from "@/lib/teaserPoll";
import {
  createHandleUploadFiles,
  createHandleUploadDirect,
  createHandlePickGoogleDrive,
  createHandleExtractText,
} from "@/components/deal-intake/uploadHandlers";

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
  /** Reports upload/extraction-in-progress state so a wrapping modal can
   *  block Escape/backdrop close while a request is in flight — closing used
   *  to abandon the result and leave the files looking like they need
   *  re-uploading. */
  onProcessingChange?: (processing: boolean) => void;
}

export function IngestDealForm({ variant = "page", onClose, preselectedDeal = null, onProcessingChange }: IngestDealFormProps) {
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

  useEffect(() => {
    onProcessingChange?.(processing);
    // Only the current value matters to the caller; onProcessingChange isn't
    // expected to be stable across renders (it's often an inline setter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing]);

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

  /* ---- Teaser polling cancellation (unmount or popup dismissed) ---- */
  const teaserPollCancelledRef = useRef(false);
  useEffect(() => () => { teaserPollCancelledRef.current = true; }, []);

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
    teaserPollCancelledRef.current = true;
    setFiles([]); setTextInput("");
    setWarning(null); clearState();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const beginProcessing = (msg: string) => {
    setProcessing(true); setProgressMessage(msg); clearState();
  };

  const endProcessing = () => {
    setProcessing(false); setProgressMessage("");
  };

  // Follow-up questions are AI — they run when the user clicks "Suggest
  // follow-up questions" on the result, not automatically after ingest.
  const fireFollowUp = () => {};

  // After a NEW deal is created, poll for its firm-criteria teaser and show
  // it as a popup once ready. Teaser generation now runs in the background
  // (the server no longer blocks the ingest response on it), so they may not
  // exist yet when we get here — poll every 2s for up to ~40s. No profiles
  // configured -> empty list forever -> polling just times out silently. The
  // deal is already created either way.
  const maybeShowTeaserPopup = useCallback(async (deal: { id: string; name: string }) => {
    teaserPollCancelledRef.current = false;
    const teasers = await pollTeasers(deal.id, {
      isCancelled: () => teaserPollCancelledRef.current,
      fetchTeasers: (dealId) => api.get<{ teasers: DealTeaser[] }>(`/deals/${dealId}/teasers`),
    });
    if (teasers && teasers.length > 0 && !teaserPollCancelledRef.current) {
      setTeaserPopup({ deal, teasers });
    }
  }, []);

  // Upload logic lives in uploadHandlers.ts (factory functions, same pattern
  // as data-room/[dealId]/file-handlers.ts) so this component stays under
  // the file-size cap. handleUploadFiles: sequential, /ingest or
  // /ingest/bulk, file 0 creates the deal in "new" mode and later files
  // merge into it sequentially. handleUploadDirect ("Upload to Data Room
  // Only"): bounded concurrency (3 at once), no deal creation/merge
  // ordering constraint.
  //
  // Each is wrapped in a thunk so the factory call (which closes over
  // maybeShowTeaserPopup, itself closing over a ref) happens lazily on
  // click, not eagerly during render — satisfies react-hooks/refs.
  const handleUploadFiles = () => createHandleUploadFiles({
    files, mode, selectedDeal,
    setError, setWarning, setResult, setFiles, setProgressMessage,
    beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup,
  })();

  const handleUploadDirect = () => createHandleUploadDirect({
    files, selectedDeal,
    setError, setResult, setFiles, setProgressMessage,
    beginProcessing, endProcessing,
  })();

  // Import a file straight from the user's Google Drive, and paste-text
  // extraction — both factored into uploadHandlers.ts alongside the file
  // upload handlers (same DI pattern, keeps this component under the
  // file-size cap). Neither is affected by the signed-URL upload change.
  const handlePickGoogleDrive = () => createHandlePickGoogleDrive({
    mode, selectedDeal, setError, setResult, beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup,
  })();

  const handleExtractText = () => createHandleExtractText({
    textInput, textSourceType, mode, selectedDeal,
    setError, setResult, beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup,
  })();

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

          {activeTab === "file" && files.length > 1 && <UploadProgressList files={files} />}
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
        <ResultWithFollowUp
          result={result}
          onReset={resetForm}
          onNavigate={onClose}
          followUpQuestions={followUpQuestions}
          followUpAnswers={followUpAnswers}
          followUpLoading={followUpLoading}
          onGenerateFollowUp={
            result.deal?.id && result.extraction
              ? () => fetchFollowUpQuestions(result.deal!.id, result.extraction)
              : undefined
          }
          onAnswer={handleFollowUpAnswer}
          onSaveAndGoToDeal={handleSaveFollowUpAndGoToDeal}
          onSkip={() => {
            if (result.deal) {
              onClose?.();
              window.location.href = `/deals/${result.deal.id}`;
            }
          }}
        />
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

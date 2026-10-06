// Upload handlers extracted from IngestDealForm so the form component stays
// under the 500-line cap. Each function is a factory that closes over the
// dependencies it needs (state + setters) and returns the async handler —
// same pattern as data-room/[dealId]/file-handlers.ts. Behavior matches the
// pre-extraction inline handlers 1:1.

import type { Dispatch, SetStateAction } from "react";
import { api } from "@/lib/api";
import { emitDealsChanged } from "@/lib/appEvents";
import { uploadViaSignedUrl, FileTooLargeError, runWithConcurrency } from "@/lib/storageUpload";
import { planFileUpload, resolveDealFromResponse } from "@/components/deal-intake/batchPlan";
import { pickGoogleFile } from "@/lib/googlePicker";
import type { DealOption, IngestResponse } from "@/app/(app)/deal-intake/components";
import type { FileUploadItem } from "@/app/(app)/deal-intake/tab-panels";

const DATA_ROOM_UPLOAD_CONCURRENCY = 3;

function errorMessage(err: unknown): string {
  if (err instanceof FileTooLargeError) return err.message;
  if (err instanceof Error) return err.message;
  return "Upload failed";
}

/* ------------------------------------------------------------------ */
/*  handleUploadFiles — "Extract & Create/Update Deal"                 */
/* ------------------------------------------------------------------ */

export interface UploadFilesDeps {
  files: FileUploadItem[];
  mode: "new" | "existing";
  selectedDeal: DealOption | null;
  setError: (msg: string | null) => void;
  setWarning: (w: { title: string; message: string } | null) => void;
  setResult: (r: IngestResponse | null) => void;
  setFiles: Dispatch<SetStateAction<FileUploadItem[]>>;
  setProgressMessage: (msg: string) => void;
  beginProcessing: (msg: string) => void;
  endProcessing: () => void;
  fireFollowUp: (data: IngestResponse) => void;
  maybeShowTeaserPopup: (deal: { id: string; name: string }) => void;
}

/**
 * Uploads every selected file sequentially. In "new" mode the FIRST file
 * creates the deal (via /ingest or /ingest/bulk for spreadsheets); every
 * subsequent file is attached to that same deal via /ingest + dealId. In
 * "existing" mode every file is attached to the selected deal. One file
 * failing doesn't abort the rest of the batch — each file gets its own
 * pending/uploading/done/failed status.
 *
 * Merges MUST stay sequential (not concurrent) — file 0 creates the deal and
 * later files need that dealId, and merging into the same deal concurrently
 * would race server-side.
 *
 * Each file uploads its bytes straight to Supabase Storage via a signed URL
 * (bypassing the server's request-body size cap), then POSTs a small JSON
 * follow-up with the storage path instead of the raw file.
 */
export function createHandleUploadFiles(deps: UploadFilesDeps) {
  const {
    files, mode, selectedDeal, setError, setWarning, setResult, setFiles,
    setProgressMessage, beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup,
  } = deps;

  return async () => {
    if (files.length === 0) return;
    if (mode === "existing" && !selectedDeal) { setError("Please select a deal first."); return; }

    beginProcessing("Extracting deal data...");
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" as const, message: undefined })));

    let createdDealId: string | null = null;
    let matchedExisting = false;
    let createdDealName: string | null = null;
    let stopReason: string | null = null;
    let skippedAfterStop = 0;
    let lastSuccessResult: IngestResponse | null = null;
    let anySucceeded = false;
    const failedNames: string[] = [];

    for (let i = 0; i < files.length; i++) {
      if (stopReason) {
        skippedAfterStop += 1;
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: stopReason! } : f)));
        continue;
      }

      const current = files[i];
      setProgressMessage(files.length > 1 ? `Processing ${current.file.name} (${i + 1}/${files.length})...` : "Extracting deal data...");
      setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "uploading", message: "Uploading…" } : f)));

      const plan = planFileUpload({
        fileName: current.file.name,
        index: i,
        mode,
        selectedDealId: selectedDeal?.id ?? null,
        createdDealId,
      });

      try {
        const meta = await uploadViaSignedUrl(current.file, {
          purpose: "ingest",
          dealId: plan.dealId,
          onStep: (step) => {
            setFiles((prev) => prev.map((f, idx) => (idx === i
              ? { ...f, message: step === "signing" ? "Uploading…" : "Reading with AI…" }
              : f)));
          },
        });

        const data = await api.post<IngestResponse>(plan.endpoint, {
          storagePath: meta.storagePath,
          fileName: meta.fileName,
          mimeType: meta.mimeType,
          size: meta.size,
          ...(plan.dealId ? { dealId: plan.dealId } : {}),
        });

        anySucceeded = true;
        lastSuccessResult = data;
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "done", message: undefined } : f)));
        emitDealsChanged({ dealId: data.deal?.id, source: "ingest-upload" });
        fireFollowUp(data);

        // The first file to SUCCEED creates the deal — not file 0, which may
        // have failed (see planFileUpload).
        if (mode === "new" && !createdDealId) {
          const resolved = resolveDealFromResponse(data);
          if (resolved.multipleDeals) {
            stopReason = "Skipped — the first file created several deals. Add this document via \"Update Existing Deal\" once you know which one it belongs to.";
          } else if (resolved.dealId) {
            createdDealId = resolved.dealId;
            createdDealName = resolved.dealName;
            // Went into an existing deal for the same company (5 Oct, item 8):
            // later files follow it there, but it isn't a NEW deal.
            if (data.matchedExistingDeal) matchedExisting = true;
          }
        }
      } catch (err) {
        failedNames.push(current.file.name);
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: errorMessage(err) } : f)));
      }
    }

    endProcessing();

    // Some files failed but the deal exists: say how to add them, instead of
    // the user re-uploading the whole batch (which used to duplicate the deal).
    if (!stopReason && mode === "new" && createdDealId && failedNames.length > 0) {
      setWarning({
        title: `${failedNames.length} file${failedNames.length === 1 ? "" : "s"} not added`,
        message: `${failedNames.join(", ")} failed. Use "Update Existing Deal" and pick ${createdDealName || "this deal"} to add ${failedNames.length === 1 ? "it" : "them"}. Re-uploading the whole batch as a new deal isn't needed.`,
      });
    }

    // Only when files were actually held back: a deal-list import on its own
    // creating several deals is the expected result, not a warning.
    if (stopReason && skippedAfterStop > 0) {
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
      if (mode === "new" && createdDealId && !matchedExisting) {
        maybeShowTeaserPopup({ id: createdDealId, name: createdDealName || lastSuccessResult.deal?.name || "" });
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/*  handleUploadDirect — "Upload to Data Room Only"                    */
/* ------------------------------------------------------------------ */

export interface UploadDirectDeps {
  files: FileUploadItem[];
  selectedDeal: DealOption | null;
  setError: (msg: string | null) => void;
  setResult: (r: IngestResponse | null) => void;
  setFiles: Dispatch<SetStateAction<FileUploadItem[]>>;
  setProgressMessage: (msg: string) => void;
  beginProcessing: (msg: string) => void;
  endProcessing: () => void;
}

/**
 * Data-room-only uploads don't create/merge a deal, so there's no ordering
 * constraint between files — run them with the same bounded concurrency
 * (3 at once) as the main data-room upload flow (data-room/file-handlers.ts).
 */
export function createHandleUploadDirect(deps: UploadDirectDeps) {
  const { files, selectedDeal, setError, setResult, setFiles, setProgressMessage, beginProcessing, endProcessing } = deps;

  return async () => {
    if (files.length === 0 || !selectedDeal) return;
    beginProcessing("Uploading to Data Room...");
    setFiles((prev) => prev.map((f) => ({ ...f, status: "pending" as const, message: undefined })));

    let anySucceeded = false;
    let completed = 0;

    await runWithConcurrency(files, DATA_ROOM_UPLOAD_CONCURRENCY, async (current, i) => {
      setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "uploading", message: "Uploading…" } : f)));
      try {
        const meta = await uploadViaSignedUrl(current.file, {
          purpose: "data-room",
          dealId: selectedDeal.id,
          onStep: (step) => {
            setFiles((prev) => prev.map((f, idx) => (idx === i
              ? { ...f, message: step === "signing" ? "Uploading…" : "Saving…" }
              : f)));
          },
        });
        await api.post(`/deals/${selectedDeal.id}/documents`, {
          storagePath: meta.storagePath,
          fileName: meta.fileName,
          mimeType: meta.mimeType,
          size: meta.size,
        });
        anySucceeded = true;
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "done", message: undefined } : f)));
      } catch (err) {
        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, status: "failed", message: errorMessage(err) } : f)));
      } finally {
        completed += 1;
        setProgressMessage(files.length > 1 ? `Uploading files (${completed}/${files.length})...` : "Uploading to Data Room...");
      }
    });

    endProcessing();
    if (anySucceeded) {
      setResult({ deal: { id: selectedDeal.id, name: selectedDeal.name }, isUpdate: true });
      emitDealsChanged({ dealId: selectedDeal.id, source: "ingest-direct-upload" });
    } else {
      setError(files.length > 1 ? "All uploads failed. See the status next to each file above." : "Upload failed");
    }
  };
}

/* ------------------------------------------------------------------ */
/*  handlePickGoogleDrive / handleExtractText                          */
/* ------------------------------------------------------------------ */

export interface NonFileIngestDeps {
  mode: "new" | "existing";
  selectedDeal: DealOption | null;
  setError: (msg: string | null) => void;
  setResult: (r: IngestResponse | null) => void;
  beginProcessing: (msg: string) => void;
  endProcessing: () => void;
  fireFollowUp: (data: IngestResponse) => void;
  maybeShowTeaserPopup: (deal: { id: string; name: string }) => void;
}

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

/**
 * Imports a file straight from the user's Google Drive via the Picker, then
 * runs it through the same /ingest pipeline as an upload. Works for any
 * connected Google account (personal or Workspace). Unaffected by the
 * signed-URL upload change — Drive files never pass through the browser.
 */
export function createHandlePickGoogleDrive(deps: NonFileIngestDeps) {
  const { mode, selectedDeal, setError, setResult, beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup } = deps;
  return async () => {
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
      emitDealsChanged({ dealId: data.deal?.id, source: "ingest-drive" });
      fireFollowUp(data);
      if (mode === "new" && data.deal?.id) {
        maybeShowTeaserPopup({ id: data.deal.id, name: data.deal.name });
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Drive import failed"); }
    finally { endProcessing(); }
  };
}

export interface ExtractTextDeps extends NonFileIngestDeps {
  textInput: string;
  textSourceType: string;
}

export function createHandleExtractText(deps: ExtractTextDeps) {
  const { textInput, textSourceType, mode, selectedDeal, setError, setResult, beginProcessing, endProcessing, fireFollowUp, maybeShowTeaserPopup } = deps;
  return async () => {
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
}

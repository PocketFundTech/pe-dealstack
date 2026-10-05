// Direct browser -> Supabase Storage upload via a server-issued signed
// upload URL. Replaces routing file bytes through the API server.
//
// Why: production (Vercel) rejects any request body over 4.5MB before the
// app even runs (413 FUNCTION_PAYLOAD_TOO_LARGE), but the ingest UI
// advertised a 50MB limit — so any CIM/model over ~4.5MB failed with a
// misleading "Maximum upload size is 50MB." error. Uploading straight to
// Supabase Storage from the browser sidesteps the serverless body-size cap
// entirely and removes a full extra transfer of the file through our
// server (browser -> API -> storage becomes browser -> storage).
//
// Flow: POST /api/uploads/sign (JSON, tiny body) -> { storagePath, token,
// signedUrl } -> supabase.storage.from('documents').uploadToSignedUrl(...)
// -> caller POSTs a small JSON follow-up (storagePath + metadata, no file
// bytes) to the real ingest/document endpoint.

import { api, ApiError } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

export type UploadPurpose = "ingest" | "data-room";

// Mirrors the server-side limits documented for POST /uploads/sign.
export const INGEST_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const DATA_ROOM_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export function maxSizeForPurpose(purpose: UploadPurpose): number {
  return purpose === "data-room" ? DATA_ROOM_MAX_FILE_SIZE : INGEST_MAX_FILE_SIZE;
}

function formatMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/** Thrown before any network call when a file exceeds the client-known
 *  limit for its purpose — avoids paying for a sign request + upload just
 *  to be rejected by the server's own size check. */
export class FileTooLargeError extends Error {
  readonly fileName: string;
  constructor(fileName: string, maxSize: number) {
    super(`${fileName} exceeds the maximum upload size of ${formatMB(maxSize)}.`);
    this.name = "FileTooLargeError";
    this.fileName = fileName;
  }
}

export interface UploadedFileMeta {
  storagePath: string;
  fileName: string;
  mimeType: string;
  size: number;
}

interface SignedUploadResponse {
  storagePath: string;
  token: string;
  signedUrl: string;
}

export type UploadStep = "signing" | "uploading";

export interface UploadViaSignedUrlOptions {
  purpose: UploadPurpose;
  /** Attach the upload to a deal's data room (purpose: 'data-room') or let
   *  the server know which deal an ingest upload is merging into. */
  dealId?: string;
  /** Fired right before each phase starts, so callers can render step text
   *  ("Uploading…" / "Reading with AI…") per file. The storage-js signed
   *  upload has no byte-level progress callback, so this is step-level only. */
  onStep?: (step: UploadStep) => void;
}

/**
 * Uploads a file directly from the browser to Supabase Storage using a
 * server-issued signed upload URL, then returns the metadata the caller
 * sends on as a JSON follow-up to the real endpoint (/ingest, /ingest/bulk,
 * or /deals/:dealId/documents) — none of which see the raw file bytes.
 *
 * Throws FileTooLargeError client-side (no network call) if the file is
 * over the purpose's limit, or the sign endpoint's ApiError/message
 * (403/400/413) if the server rejects it, or a plain Error with the
 * storage client's message if the signed-URL upload itself fails.
 */
export async function uploadViaSignedUrl(
  file: File,
  options: UploadViaSignedUrlOptions,
): Promise<UploadedFileMeta> {
  const maxSize = maxSizeForPurpose(options.purpose);
  if (file.size > maxSize) {
    throw new FileTooLargeError(file.name, maxSize);
  }

  options.onStep?.("signing");
  const signed = await api.post<SignedUploadResponse>("/uploads/sign", {
    fileName: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    purpose: options.purpose,
    ...(options.dealId ? { dealId: options.dealId } : {}),
  });

  options.onStep?.("uploading");
  const supabase = createClient();
  const { error } = await supabase.storage
    .from("documents")
    .uploadToSignedUrl(signed.storagePath, signed.token, file, {
      contentType: file.type || undefined,
    });
  if (error) {
    throw new Error(error.message || `Failed to upload ${file.name}`);
  }

  return {
    storagePath: signed.storagePath,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
  };
}

/** Re-exported so callers can branch on status (e.g. 413) from the sign
 *  step without re-parsing the error message. */
export { ApiError };

/**
 * Runs `task` over `items` with bounded concurrency — used for "Upload to
 * Data Room Only" (concurrency 3), matching the existing data-room upload
 * behavior in file-handlers.ts. Each item's task runs independently; one
 * failing doesn't stop the others (callers handle per-item try/catch).
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    let next = queue.shift();
    while (next) {
      await task(next.item, next.index);
      next = queue.shift();
    }
  });
  await Promise.all(workers);
}

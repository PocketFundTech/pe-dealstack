// VDR API — ported from vdrApi.ts. Re-uses the web-next
// `api` helper for JSON calls; upload uses raw fetch since api is JSON-only.

import { api, NotFoundError } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type {
  APIDocument,
  APIFolder,
  APIFolderInsight,
  Folder,
  FolderInsights,
  VDRFile,
} from "./types";

export async function fetchFolders(dealId: string): Promise<APIFolder[]> {
  try {
    return await api.get<APIFolder[]>(`/deals/${dealId}/folders`);
  } catch (err) {
    console.warn("[vdr] fetchFolders failed:", err);
    return [];
  }
}

export async function createFolder(
  dealId: string,
  name: string,
  parentId?: string,
): Promise<APIFolder | null> {
  try {
    return await api.post<APIFolder>(`/deals/${dealId}/folders`, {
      name,
      parentId: parentId || null,
    });
  } catch (err) {
    console.warn("[vdr] createFolder failed:", err);
    return null;
  }
}

export async function deleteFolder(folderId: string, cascade = false): Promise<boolean> {
  try {
    await api.delete(`/folders/${folderId}${cascade ? "?cascade=true" : ""}`);
    return true;
  } catch (err) {
    console.warn("[vdr] deleteFolder failed:", err);
    return false;
  }
}

export async function renameFolder(folderId: string, newName: string): Promise<boolean> {
  try {
    await api.patch(`/folders/${folderId}`, { name: newName });
    return true;
  } catch (err) {
    console.warn("[vdr] renameFolder failed:", err);
    return false;
  }
}

export async function fetchDocuments(
  dealId: string,
  folderId?: string,
): Promise<APIDocument[]> {
  try {
    const path = folderId
      ? `/folders/${folderId}/documents`
      : `/deals/${dealId}/documents`;
    const data = await api.get<APIDocument[] | { documents: APIDocument[] }>(path);
    return Array.isArray(data) ? data : data.documents || [];
  } catch (err) {
    console.warn("[vdr] fetchDocuments failed:", err);
    return [];
  }
}

export async function uploadDocument(
  dealId: string,
  folderId: string,
  file: File,
  options?: { autoUpdateDeal?: boolean },
): Promise<APIDocument | null> {
  const supabase = createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const formData = new FormData();
  formData.append("file", file);
  formData.append("folderId", folderId);
  formData.append("type", "OTHER");
  if (options?.autoUpdateDeal) {
    formData.append("autoUpdateDeal", "true");
  }

  const res = await fetch(`/api/deals/${dealId}/documents`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload failed (${res.status})`);
  }
  return res.json();
}

export async function deleteDocument(documentId: string): Promise<boolean> {
  try {
    await api.delete(`/documents/${documentId}`);
    return true;
  } catch (err) {
    console.warn("[vdr] deleteDocument failed:", err);
    return false;
  }
}

export async function renameDocument(documentId: string, newName: string): Promise<boolean> {
  try {
    await api.patch(`/documents/${documentId}`, { name: newName });
    return true;
  } catch (err) {
    console.warn("[vdr] renameDocument failed:", err);
    return false;
  }
}

/**
 * Re-analyze a document — downloads the file, extracts text, writes it back
 * on Document.extractedText, and triggers RAG embedding. Returns 422 on
 * unsupported types (e.g. images without OCR). Ported from 68ff3f8.
 */
export async function analyzeDocument(documentId: string): Promise<void> {
  await api.post(`/documents/${documentId}/analyze`, {});
}

export async function getDocumentDownloadUrl(documentId: string): Promise<string | null> {
  try {
    const data = await api.get<{ url: string }>(`/documents/${documentId}/download`);
    return data.url;
  } catch (err) {
    console.warn("[vdr] download url failed:", err);
    return null;
  }
}

/**
 * Trigger a document download in the browser. Handles two response shapes
 * from /api/documents/:id/download:
 *   1. application/pdf binary — server streamed a watermarked PDF; we save
 *      it as a blob and trigger a download.
 *   2. application/json — server returned `{ url, name }` for a passthrough
 *      file (non-PDF or oversized PDF); we navigate to the signed URL.
 *
 * Returns true on success, false on failure.
 */
export async function downloadDocument(
  documentId: string,
  fallbackName = "document",
): Promise<boolean> {
  try {
    const res = await api.getRaw(`/documents/${documentId}/download`);
    if (!res.ok) {
      console.warn("[vdr] download failed:", res.status);
      return false;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    if (contentType.includes("application/pdf")) {
      // Watermarked PDF binary path
      const blob = await res.blob();
      const filename = parseFilenameFromContentDisposition(
        res.headers.get("content-disposition"),
      ) ?? `${fallbackName}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    }

    // Passthrough JSON path
    const data = (await res.json()) as { url?: string; name?: string };
    if (!data.url) {
      console.warn("[vdr] download response missing url");
      return false;
    }
    window.location.href = data.url;
    return true;
  } catch (err) {
    console.warn("[vdr] download failed:", err);
    return false;
  }
}

function parseFilenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  // matches:  attachment; filename="my doc.pdf"
  const match = value.match(/filename\s*=\s*"?([^";]+)"?/i);
  return match?.[1] ?? null;
}

export async function fetchFolderInsights(
  folderId: string,
): Promise<APIFolderInsight | null> {
  try {
    return await api.get<APIFolderInsight>(`/folders/${folderId}/insights`);
  } catch (err) {
    // 404 just means no insights yet — that's the normal state for folders
    // that haven't had insights generated. Stay silent for those.
    if (err instanceof NotFoundError) {
      return null;
    }
    // Real errors (5xx, network, auth) still get logged.
    console.warn("[vdr] folder insights fetch failed:", err);
    return null;
  }
}

export async function generateInsights(folderId: string): Promise<APIFolderInsight | null> {
  // 60s+ AI call — errors surface to caller
  return api.post<APIFolderInsight>(`/folders/${folderId}/generate-insights`, {});
}

export async function requestDocument(
  dealId: string,
  documentName: string,
  options?: { folderId?: string; folderName?: string },
): Promise<{ success: boolean; message: string }> {
  return api.post(`/deals/${dealId}/document-requests`, {
    documentName,
    folderId: options?.folderId,
    folderName: options?.folderName,
  });
}

/**
 * Extract financials from a VDR document — calls GPT-4o to parse financial data.
 */
export async function extractFinancials(
  dealId: string,
  documentId: string,
): Promise<{ result?: { periodsStored?: number }; stored?: number }> {
  return api.post(`/deals/${dealId}/financials/extract`, { documentId });
}

/**
 * Link (copy) a document to another deal.
 */
export async function linkDocumentToDeal(
  documentId: string,
  targetDealId: string,
): Promise<APIDocument | null> {
  return api.post(`/documents/${documentId}/link`, { targetDealId });
}

/**
 * Fetch all deals (for the deal picker in link-to-deal modal).
 */
export async function fetchAllDeals(): Promise<
  Array<{ id: string; name: string; industry?: string }>
> {
  try {
    const data = await api.get<
      Array<{ id: string; name: string; industry?: string }> | { deals: Array<{ id: string; name: string; industry?: string }> }
    >("/deals?limit=100");
    return Array.isArray(data) ? data : data.deals || [];
  } catch (err) {
    console.warn("[vdr] fetchAllDeals failed:", err);
    return [];
  }
}

export async function initializeDealFolders(
  dealId: string,
): Promise<{ created: boolean; folders: APIFolder[] }> {
  try {
    return await api.post<{ created: boolean; folders: APIFolder[] }>(
      `/deals/${dealId}/folders/init`,
      {},
    );
  } catch (err) {
    console.warn("[vdr] initializeDealFolders failed:", err);
    return { created: false, folders: [] };
  }
}

export async function fetchDeal(dealId: string): Promise<{ id: string; name: string } | null> {
  try {
    return await api.get<{ id: string; name: string }>(`/deals/${dealId}`);
  } catch (err) {
    console.warn("[vdr] fetchDeal failed:", err);
    return null;
  }
}

// ─── Transformers ────────────────────────────────────────────────────────

export function transformFolder(apiFolder: APIFolder): Folder {
  const insight = apiFolder.FolderInsight?.[0];
  const completionPercent = insight?.completionPercent || 0;
  const hasRedFlags = (insight?.redFlags?.length || 0) > 0;

  let status: Folder["status"] = "reviewing";
  let statusLabel = "Reviewing";
  let statusColor: Folder["statusColor"] = "yellow";

  if (apiFolder.isRestricted) {
    status = "restricted";
    statusLabel = "Access Restricted";
    statusColor = "slate";
  } else if (completionPercent >= 80 && !hasRedFlags) {
    status = "ready";
    statusLabel = `${completionPercent}% Ready`;
    statusColor = "green";
  } else if (hasRedFlags) {
    status = "attention";
    statusLabel = "Attention";
    statusColor = "orange";
  }

  return {
    id: apiFolder.id,
    name: apiFolder.name,
    status,
    readinessPercent: completionPercent,
    fileCount: apiFolder.fileCount || 0,
    statusLabel,
    statusColor,
    isRestricted: apiFolder.isRestricted,
  };
}

export function transformDocument(apiDoc: APIDocument): VDRFile {
  // File type from mime/extension
  let fileType: VDRFile["type"] = "other";
  const mime = apiDoc.mimeType || "";
  const name = apiDoc.name.toLowerCase();
  if (mime.includes("excel") || mime.includes("spreadsheet") || name.endsWith(".xlsx") || name.endsWith(".xls")) {
    fileType = "excel";
  } else if (mime.includes("pdf") || name.endsWith(".pdf")) {
    fileType = "pdf";
  } else if (mime.includes("word") || mime.includes("document") || name.endsWith(".doc") || name.endsWith(".docx")) {
    fileType = "doc";
  }

  // Size
  let sizeStr = "0 KB";
  if (apiDoc.fileSize) {
    if (apiDoc.fileSize >= 1024 * 1024) {
      sizeStr = `${(apiDoc.fileSize / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      sizeStr = `${Math.round(apiDoc.fileSize / 1024)} KB`;
    }
  }

  // Analysis — three-state: Pending → Ready for AI → Analyzed
  // (ported from vdrApi.ts transformDocument, 68ff3f8)
  let analysisType: VDRFile["analysis"]["type"] = "standard";
  let analysisLabel = "Pending Analysis";
  let analysisDescription = "Document awaiting text extraction.";
  let analysisColor: VDRFile["analysis"]["color"] = "slate";

  const ai = apiDoc.aiAnalysis;
  if (ai) {
    if (ai.type === "warning" || ai.hasRisks) {
      analysisType = "warning";
      analysisLabel = ai.label || "Warning";
      analysisDescription = ai.description || "This document contains items requiring attention.";
      analysisColor = "orange";
    } else if (ai.type === "key-insight" || ai.keyInsight) {
      analysisType = "key-insight";
      analysisLabel = ai.label || "Key Insight";
      analysisDescription = ai.description || ai.keyInsight || "Important information identified.";
      analysisColor = "primary";
    } else {
      analysisType = "complete";
      analysisLabel = "Analysis Complete";
      analysisDescription = ai.description || ai.summary || "Document analyzed successfully.";
      analysisColor = "primary";
    }
  } else if (apiDoc.aiAnalyzedAt || apiDoc.status === "analyzed") {
    analysisType = "complete";
    analysisLabel = "Analysis Complete";
    analysisDescription = "Document has been analyzed.";
    analysisColor = "primary";
  } else if (apiDoc.status === "completed") {
    analysisType = "complete";
    analysisLabel = "Processed";
    analysisDescription = "Document uploaded and text extracted.";
    analysisColor = "primary";
  } else if (apiDoc.extractedText) {
    analysisType = "ready";
    analysisLabel = "Ready for AI";
    analysisDescription = "Text extracted. Ready for AI analysis.";
    analysisColor = "green";
  } else if (apiDoc.status === "processing") {
    analysisType = "standard";
    analysisLabel = "Processing...";
    analysisDescription = "Document is being analyzed.";
    analysisColor = "slate";
  }

  return {
    id: apiDoc.id,
    name: apiDoc.name,
    size: sizeStr,
    type: fileType,
    analysis: {
      type: analysisType,
      label: analysisLabel,
      description: analysisDescription,
      color: analysisColor,
    },
    author: {
      name: apiDoc.uploader?.name || "Unknown",
      avatar: apiDoc.uploader?.avatar || "",
    },
    date: new Date(apiDoc.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    folderId: apiDoc.folderId || "",
    isHighlighted: apiDoc.isHighlighted,
    tags: apiDoc.tags || [],
  };
}

export function transformInsights(
  apiInsight: APIFolderInsight | null,
  folderId: string,
): FolderInsights {
  if (!apiInsight) {
    return {
      folderId,
      summary: "No insights available for this folder yet.",
      completionPercent: 0,
      redFlags: [],
      missingDocuments: [],
    };
  }

  return {
    folderId: apiInsight.folderId,
    summary: apiInsight.summary || "No summary available.",
    completionPercent: apiInsight.completionPercent || 0,
    redFlags: (apiInsight.redFlags || []).map((rf, idx) => ({
      id: rf.id || `rf-${idx}`,
      severity: rf.severity || "medium",
      title: rf.title || "Unknown Issue",
      description: rf.description || "",
      fileId: rf.fileId,
      color: rf.severity === "high" ? "red" : "orange",
    })),
    missingDocuments: (apiInsight.missingDocuments || []).map((md, idx) => ({
      id: md.id || `md-${idx}`,
      name: md.name || "Unknown Document",
    })),
  };
}

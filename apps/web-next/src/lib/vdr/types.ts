// VDR type definitions — ported 1:1 from vdr.types.ts so the
// two implementations share the same shape and transformers are drop-in compatible.

export type FolderStatus = "ready" | "attention" | "reviewing" | "restricted";

export interface Folder {
  id: string;
  name: string;
  status: FolderStatus;
  readinessPercent?: number;
  fileCount: number;
  statusLabel: string;
  statusColor: "green" | "orange" | "yellow" | "slate";
  isRestricted?: boolean;
}

export type FileType = "excel" | "pdf" | "doc" | "other";

export type AnalysisType = "key-insight" | "warning" | "standard" | "complete" | "ready";

export interface FileAnalysis {
  type: AnalysisType;
  label: string;
  description: string;
  color: "primary" | "orange" | "slate" | "green";
}

export interface VDRFile {
  id: string;
  name: string;
  size: string;
  type: FileType;
  analysis: FileAnalysis;
  author: { name: string; avatar: string };
  date: string;
  folderId: string;
  isHighlighted?: boolean;
  tags?: string[];
  // Raw Document.status ('pending' | 'processing' | 'completed' | 'analyzed'
  // | 'failed') — kept alongside the derived `analysis` presentation fields
  // so callers that need the literal processing state (e.g. the upload
  // poller) don't have to reverse-engineer it from analysis.label.
  status?: string;
  // Document type (CIM / FINANCIALS / LEGAL / ...) shown as a small badge
  // in the file table, next to the size.
  docType?: string;
}

export type RedFlagSeverity = "high" | "medium";

export interface RedFlag {
  id: string;
  severity: RedFlagSeverity;
  title: string;
  description: string;
  fileId?: string;
  color: "red" | "orange";
}

export interface MissingDocument {
  id: string;
  name: string;
}

export interface FolderInsights {
  folderId: string;
  summary: string;
  completionPercent: number;
  redFlags: RedFlag[];
  missingDocuments: MissingDocument[];
}

export interface SmartFilter {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  isCustom?: boolean;
  filterFn: (file: VDRFile) => boolean;
}

// API shapes (what the backend returns) — distinct from the UI types above so
// we can keep transformers pure.

export interface APIFolderInsight {
  id: string;
  folderId: string;
  summary: string;
  completionPercent: number;
  redFlags: Array<{
    id?: string;
    severity?: "high" | "medium";
    title?: string;
    description?: string;
    fileId?: string;
  }>;
  missingDocuments: Array<{ id?: string; name?: string }>;
  generatedAt: string;
}

export interface APIFolder {
  id: string;
  dealId: string;
  parentId: string | null;
  name: string;
  description?: string;
  isRestricted: boolean;
  sortOrder: number;
  fileCount?: number;
  createdAt: string;
  updatedAt: string;
  FolderInsight?: APIFolderInsight[];
}

export interface APIDocument {
  id: string;
  dealId: string;
  folderId?: string;
  name: string;
  type: string;
  fileUrl?: string;
  fileSize?: number;
  mimeType?: string;
  status?: string;
  extractedText?: string;
  aiAnalysis?: {
    type?: string;
    label?: string;
    description?: string;
    summary?: string;
    keyInsight?: string;
    hasRisks?: boolean;
  };
  aiAnalyzedAt?: string;
  tags?: string[];
  isHighlighted?: boolean;
  uploader?: { id: string; name: string; avatar?: string };
  createdAt: string;
  updatedAt: string;
}

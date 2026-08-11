// Google Drive client types. Drive is NOT a standalone integration provider —
// it piggybacks on the `google_calendar` provider's OAuth token (which has
// `drive.file` + `documents` scopes since the Workspace expansion).

export interface CreateDocResult {
  id: string;
  webViewLink: string;
}

export interface DocMetadataResult {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
}

// Lightweight metadata for an arbitrary Drive file picked for ingest.
// `size` is absent for native Google types (Docs/Sheets), which have no
// binary byte size until exported.
export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

export type GoogleDriveErrorCode =
  | 'DRIVE_API_ERROR'
  | 'INVALID_TOKEN'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_SCOPE';

export class GoogleDriveError extends Error {
  code: GoogleDriveErrorCode;
  status?: number;
  details?: string;

  constructor(
    code: GoogleDriveErrorCode,
    message: string,
    status?: number,
    details?: string,
  ) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

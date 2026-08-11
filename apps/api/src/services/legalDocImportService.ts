// Imports an NDA already sent or signed outside the app. The /upload
// route is a thin wrapper around this — it owns multer + req parsing,
// this owns parse + insert. Keeps the route file lean (500-line cap)
// and makes the import path independently testable.
//
// DRAFT is intentionally NOT a valid status here. The create-from-
// template flow is the only path that produces a DRAFT — letting an
// import bypass it would defeat the placeholder substitution guarantee.

import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import {
  parseTemplateFile,
  sanitiseLegalDocHtml,
  LegalDocParseError,
  type TemplateFileKind,
} from './legalDocParseService.js';

// Re-exported so the route can `throw` / `instanceof` without a second
// import of legalDocParseService just for the error type.
export { LegalDocParseError } from './legalDocParseService.js';

export class LegalDocImportError extends Error {
  // PDF_NOT_SUPPORTED retained for backwards compatibility — no longer
  // thrown by the import path (PDFs are accepted now), but keeping the
  // string literal avoids breaking any external consumer importing the
  // type. New rejects use INVALID_FILE_FORMAT.
  code: 'PDF_NOT_SUPPORTED' | 'INVALID_FILE_FORMAT' | 'INVALID_METADATA' | 'DEAL_NOT_FOUND';
  status: number;
  details?: unknown;
  constructor(
    message: string,
    code: LegalDocImportError['code'],
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'LegalDocImportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const UPLOAD_KIND_VALUES = ['docx', 'html', 'md', 'pdf'] as const;

export const uploadKindSchema = z.object({
  kind: z.enum(UPLOAD_KIND_VALUES),
});

export const uploadMetadataSchema = z.object({
  title: z.string().min(1).max(500),
  status: z.enum(['SENT', 'SIGNED']),
  counterpartyName: z.string().max(500).optional(),
  counterpartyEmail: z.string().email().max(500).optional(),
  counterpartyAddress: z.string().max(2000).optional(),
  jurisdiction: z.string().max(500).optional(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sentAt: z.string().datetime().optional(),
  signedAt: z.string().datetime().optional(),
  sentToEmail: z.string().email().max(500).optional(),
});

export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;

export interface ImportLegalDocInput {
  organizationId: string;
  dealId: string;
  createdById: string;
  file: { originalname?: string; buffer: Buffer; kind: TemplateFileKind };
  metadata: UploadMetadata;
}

/**
 * Parse-then-insert pipeline shared by the /upload route. Throws
 * LegalDocImportError on parse + validation errors so the route can
 * map them to HTTP responses cleanly. Any other error bubbles as-is.
 */
export async function importLegalDocument(input: ImportLegalDocInput) {
  const { organizationId, dealId, createdById, file, metadata } = input;

  let parseResult;
  try {
    parseResult = await parseTemplateFile({
      buffer: file.buffer,
      kind: file.kind,
    });
  } catch (err) {
    if (err instanceof LegalDocParseError) throw err;
    throw err;
  }
  const content = sanitiseLegalDocHtml(parseResult.bodyHtml);

  const insertRow = {
    organizationId,
    dealId,
    createdById,
    // /nda surface is NDA-only for v1; broader doc-type picker is future work.
    docType: 'NDA' as const,
    title: metadata.title,
    status: metadata.status,
    counterpartyName: metadata.counterpartyName ?? null,
    counterpartyEmail: metadata.counterpartyEmail ?? null,
    counterpartyAddress: metadata.counterpartyAddress ?? null,
    jurisdiction: metadata.jurisdiction ?? null,
    effectiveDate: metadata.effectiveDate ?? null,
    expiresAt: metadata.expiresAt ?? null,
    sentAt: metadata.sentAt ?? null,
    signedAt: metadata.signedAt ?? null,
    sentToEmail: metadata.sentToEmail ?? null,
    // No template linkage — this row was imported, not generated.
    templateId: null,
    // Same value for both content + snapshot: an imported NDA is
    // finalized at upload time so the "what was sent" view matches the
    // current content. Editor.tsx already handles the snapshot toggle.
    content,
    contentSnapshot: content,
    googleDocId: null,
    googleDocUrl: null,
    metadata: { importedAt: new Date().toISOString() },
  };

  const { data, error } = await supabase
    .from('LegalDocument')
    .insert(insertRow)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

/**
 * Coerces multer's raw req.body (everything is a string by default) into
 * an object the metadata schema can validate. Drops empty-string fields
 * so optional zod props stay genuinely optional. Excludes `kind` + `file`
 * which are parsed separately.
 */
export function pickUploadMetadataFromForm(
  body: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === 'kind' || k === 'file') continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Express handler for POST /deals/:dealId/legal-documents/upload — lives
 * here so the route file stays under the 500-line cap. Caller wires
 * multer's upload.single('file') middleware in the route registration.
 *
 * `resolveInternalUserId` is injected so the service doesn't have to
 * duplicate User-lookup logic that the route owns.
 */
export interface UploadHandlerDeps {
  resolveInternalUserId: (authId: string) => Promise<string | null>;
}

export function makeUploadLegalDocumentHandler(deps: UploadHandlerDeps) {
  const { resolveInternalUserId } = deps;
  return async function uploadHandler(req: Request, res: Response) {
    try {
      const orgId = getOrgId(req);
      const { dealId } = req.params;
      const deal = await verifyDealAccess(dealId, orgId);
      if (!deal) return res.status(404).json({ error: 'Deal not found' });

      if (!req.user?.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const internalUserId = await resolveInternalUserId(req.user.id);
      if (!internalUserId) return res.status(404).json({ error: 'User not found' });

      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({
          error: 'Missing file upload',
          code: 'INVALID_FILE_FORMAT',
        });
      }

      // PDFs are accepted now — parsed via pdf-parse in legalDocParseService.
      // Text extraction is structureless (no headings/bold) so the imported
      // body is plain paragraphs; the user can edit in the in-app editor
      // afterwards if they want to add structure.
      const kindParsed = uploadKindSchema.safeParse({ kind: req.body?.kind });
      if (!kindParsed.success) {
        return res.status(400).json({
          error: 'Invalid kind — expected docx | html | md | pdf',
          code: 'INVALID_FILE_FORMAT',
          details: kindParsed.error.errors,
        });
      }

      const metaParsed = uploadMetadataSchema.safeParse(
        pickUploadMetadataFromForm(req.body as Record<string, unknown>),
      );
      if (!metaParsed.success) {
        return res.status(400).json({
          error: 'Invalid metadata',
          details: metaParsed.error.errors,
        });
      }

      const inserted = await importLegalDocument({
        organizationId: orgId,
        dealId,
        createdById: internalUserId,
        file: {
          originalname: file.originalname,
          buffer: file.buffer,
          kind: kindParsed.data.kind as TemplateFileKind,
        },
        metadata: metaParsed.data,
      });

      return res.status(201).json(inserted);
    } catch (err) {
      if (err instanceof LegalDocParseError) {
        return res.status(err.status).json({
          error: err.message,
          code: err.code,
          details: err.details,
        });
      }
      log.error('POST /api/deals/:dealId/legal-documents/upload error', err);
      return res.status(500).json({ error: 'Failed to import legal document' });
    }
  };
}

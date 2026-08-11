// ─── /api/legal-documents + /api/deals/:dealId/legal-documents ───
// LegalDocument routes — Phase 2 (in-app HTML).
//
// Endpoints (mounted at /api in app.ts):
//   GET    /legal-documents?docType=NDA           — cross-deal, org-scoped
//   GET    /deals/:dealId/legal-documents         — per-deal
//   POST   /deals/:dealId/legal-documents         — create from template
//   PATCH  /legal-documents/:id                   — update fields incl. content
//   DELETE /legal-documents/:id                   — soft delete (metadata.deletedAt)
//   POST   /legal-documents/:id/send              — Resend .docx delivery
//
// Soft delete: metadata->>'deletedAt'. GET lists exclude soft-deleted rows.
// Joined Deal alias mirrors graphs.ts so the frontend contract is shared.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import {
  sanitiseLegalDocHtml,
} from '../services/legalDocParseService.js';
import {
  substituteTokens,
  type LegalDocTokenValues,
} from '../services/legalDocSubstituteService.js';
import {
  sendLegalDocument,
  LegalDocSendError,
} from '../services/legalDocSendService.js';
import { makeUploadLegalDocumentHandler } from '../services/legalDocImportService.js';
import {
  importGoogleDoc,
  LegalDocImportGdocError,
} from '../services/legalDocImportGdocService.js';
import { loadDealForLegalDoc, loadOrgForLegalDoc } from '../services/legalDocLookups.js';
import {
  requestLegalDocSignature,
  LegalDocSignatureError,
} from '../services/legalDocSignatureService.js';
import {
  exportLegalDocument,
  LegalDocExportError,
} from '../services/legalDocExportService.js';
import { pollOrgSignatures } from '../services/legalDocSignaturePollService.js';

// 25 MB cap mirrors the template-parse upload — the underlying parser is
// shared and rejects anything it can't decode with INVALID_FILE_FORMAT.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const router = Router();

// ============================================================
// Validation
// ============================================================

const DOC_TYPES = [
  'NDA', 'LOI', 'TERM_SHEET', 'DEFINITIVE_AGREEMENT', 'SIDE_LETTER', 'OTHER',
] as const;
const STATUSES = ['DRAFT', 'SENT', 'SIGNED', 'EXPIRED'] as const;

const listQuerySchema = z.object({
  docType: z.enum(DOC_TYPES).optional(),
});

const createBodySchema = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1).max(500),
  counterpartyName: z.string().max(500).optional(),
  counterpartyEmail: z.string().email().max(500).optional(),
  counterpartyAddress: z.string().max(2000).optional(),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jurisdiction: z.string().max(500).optional(),
});

// Import-an-existing-Google-Doc body. `url` accepts a full Doc URL or a bare
// file id (parsing/validation of the id happens in the import service so the
// 400 INVALID_GDOC_URL code is owned in one place).
const importGdocBodySchema = z
  .object({
    url: z.string().min(1).max(2000).optional(),
    fileId: z.string().min(10).max(256).optional(),
    title: z.string().min(1).max(500).optional(),
    counterpartyName: z.string().max(500).optional(),
    counterpartyEmail: z.string().email().max(500).optional(),
    counterpartyAddress: z.string().max(2000).optional(),
    jurisdiction: z.string().max(500).optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(v => Boolean(v.fileId || v.url), {
    message: 'Provide a Google Doc fileId or url',
  });

const patchBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    status: z.enum(STATUSES).optional(),
    counterpartyName: z.string().max(500).nullable().optional(),
    counterpartyEmail: z.string().email().max(500).nullable().optional(),
    counterpartyAddress: z.string().max(2000).nullable().optional(),
    jurisdiction: z.string().max(500).nullable().optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    signedAt: z.string().datetime().nullable().optional(),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    content: z.string().max(2_000_000).nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'At least one field required' });

const sendBodySchema = z.object({
  toEmail: z.string().email().max(500).optional(),
  subject: z.string().max(500).optional(),
  message: z.string().max(20_000).optional(),
});

// Upload-existing schemas live in legalDocImportService — keeps the route
// file under the 500-line cap and lets the import path be unit-tested
// independently of Express plumbing.

function isMissingTableError(error: { code?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205';
}

async function resolveInternalUserId(authId: string): Promise<string | null> {
  const { data } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authId)
    .single();
  return data?.id ?? null;
}

interface TemplateRow {
  id: string;
  organizationId: string;
  bodyHtml: string | null;
  docType: string;
  verifiedAt: string | null;
}

async function loadTemplate(templateId: string, orgId: string): Promise<TemplateRow | null> {
  const { data, error } = await supabase
    .from('LegalDocTemplate')
    .select('id, organizationId, bodyHtml, docType, verifiedAt')
    .eq('id', templateId)
    .eq('organizationId', orgId)
    .maybeSingle();
  if (error) throw error;
  return (data as TemplateRow | null) ?? null;
}

// Deal + Org loaders are shared with the send/signature service paths via
// ../services/legalDocLookups.js (token-substitution row shape).

// ============================================================
// GET /legal-documents — cross-deal list, org-scoped
// ============================================================

router.get('/legal-documents', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.errors });
    }

    // Aliased Deal join so the wire shape matches the frontend contract
    // (LegalDocumentWithDeal.deal in apps/web-next, mirrors GraphWithDeal).
    // The "target" the frontend cards display is actually Company.name,
    // joined through the Deal -> Company FK that other routes also use
    // (see memos-list.ts:60 for the same pattern). We flatten the nested
    // company.name back into target before responding so the frontend
    // doesn't have to know about the second table.
    let query = supabase
      .from('LegalDocument')
      .select('*, deal:Deal(id, projectName:name, company:Company(name))')
      .eq('organizationId', orgId)
      .is('metadata->>deletedAt', null)
      .order('updatedAt', { ascending: false });

    if (parsed.data.docType) {
      query = query.eq('docType', parsed.data.docType);
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) return res.json([]);
      throw error;
    }

    const rows = (data ?? []).map((row: Record<string, unknown>) => {
      const dealRaw = row.deal as
        | { id: string; projectName: string | null; company?: { name: string | null } | null }
        | null;
      if (!dealRaw) return { ...row, deal: null };
      return {
        ...row,
        deal: {
          id: dealRaw.id,
          projectName: dealRaw.projectName ?? null,
          target: dealRaw.company?.name ?? null,
        },
      };
    });
    res.json(rows);
  } catch (err) {
    log.error('GET /api/legal-documents error', err);
    res.status(500).json({ error: 'Failed to fetch legal documents' });
  }
});

// ============================================================
// GET /deals/:dealId/legal-documents — per-deal list
// ============================================================

router.get('/deals/:dealId/legal-documents', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { dealId } = req.params;
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.errors });
    }

    let query = supabase
      .from('LegalDocument')
      .select('*')
      .eq('organizationId', orgId)
      .eq('dealId', dealId)
      .is('metadata->>deletedAt', null)
      .order('updatedAt', { ascending: false });

    if (parsed.data.docType) {
      query = query.eq('docType', parsed.data.docType);
    }

    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) return res.json([]);
      throw error;
    }

    res.json(data ?? []);
  } catch (err) {
    log.error('GET /api/deals/:dealId/legal-documents error', err);
    res.status(500).json({ error: 'Failed to fetch legal documents' });
  }
});

// ============================================================
// POST /deals/:dealId/legal-documents — create from template
// ============================================================

router.post('/deals/:dealId/legal-documents', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { dealId } = req.params;
    const deal = await loadDealForLegalDoc(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
    }

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const template = await loadTemplate(parsed.data.templateId, orgId);
    if (!template) {
      return res.status(404).json({
        error: 'Template not found',
        code: 'TEMPLATE_NOT_FOUND',
      });
    }
    if (!template.verifiedAt) {
      return res.status(400).json({
        error: 'Template has not been verified — admin must mark placeholders first',
        code: 'TEMPLATE_NOT_VERIFIED',
      });
    }
    if (!template.bodyHtml) {
      return res.status(400).json({
        error: 'Template has no body content',
        code: 'TEMPLATE_NOT_VERIFIED',
      });
    }

    const org = await loadOrgForLegalDoc(orgId);
    const todayIso = new Date().toISOString().slice(0, 10);

    const tokens: LegalDocTokenValues = {
      COUNTERPARTY_NAME: parsed.data.counterpartyName,
      COUNTERPARTY_ADDRESS: parsed.data.counterpartyAddress,
      COUNTERPARTY_EMAIL: parsed.data.counterpartyEmail,
      EFFECTIVE_DATE: parsed.data.effectiveDate,
      JURISDICTION: parsed.data.jurisdiction,
      DEAL_NAME: deal.name ?? deal.company?.name ?? '',
      FIRM_NAME: org?.name ?? '',
      TODAY: todayIso,
    };
    const substituted = substituteTokens(template.bodyHtml, tokens);
    // Belt + suspenders: sanitise again after substitution — token
    // values are user input and could (in theory) inject markup.
    const content = sanitiseLegalDocHtml(substituted);

    const insertRow = {
      organizationId: orgId,
      dealId,
      createdById: internalUserId,
      docType: template.docType ?? 'NDA',
      title: parsed.data.title,
      counterpartyName: parsed.data.counterpartyName ?? null,
      counterpartyEmail: parsed.data.counterpartyEmail ?? null,
      counterpartyAddress: parsed.data.counterpartyAddress ?? null,
      jurisdiction: parsed.data.jurisdiction ?? null,
      effectiveDate: parsed.data.effectiveDate ?? null,
      status: 'DRAFT' as const,
      templateId: template.id,
      content,
      metadata: {},
    };

    const { data, error } = await supabase
      .from('LegalDocument')
      .insert(insertRow)
      .select('*')
      .single();
    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    log.error('POST /api/deals/:dealId/legal-documents error', err);
    res.status(500).json({ error: 'Failed to create legal document' });
  }
});

// ============================================================
// POST /deals/:dealId/legal-documents/upload — import existing NDA
// ============================================================
//
// Multipart import for an NDA already sent or signed outside the app.
// Skips template + Google Doc + Gmail send; stores parsed HTML as both
// content + contentSnapshot. DRAFT rejected — handler in import service.
router.post(
  '/deals/:dealId/legal-documents/upload',
  upload.single('file'),
  makeUploadLegalDocumentHandler({ resolveInternalUserId }),
);

// ============================================================
// POST /deals/:dealId/legal-documents/import-gdoc — import existing Google Doc
// ============================================================
//
// "Bring your own Google Doc": the user pastes the URL of a Doc they already
// prepared in their own Drive (with an eSignature field added manually in the
// Docs UI). We import a reference to it; /send later shares + emails THAT doc
// instead of creating a new one. Signature polling works on any row with a
// googleDocId, so detection comes for free. Mounted here (before the literal
// `/legal-documents/:id...` routes) so the path segment isn't matched as `:id`.
router.post('/deals/:dealId/legal-documents/import-gdoc', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { dealId } = req.params;
    const deal = await loadDealForLegalDoc(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const parsed = importGdocBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
    }

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const inserted = await importGoogleDoc({
      dealId,
      organizationId: orgId,
      userId: internalUserId,
      url: parsed.data.url,
      fileId: parsed.data.fileId,
      title: parsed.data.title,
      counterpartyName: parsed.data.counterpartyName,
      counterpartyEmail: parsed.data.counterpartyEmail,
      counterpartyAddress: parsed.data.counterpartyAddress,
      jurisdiction: parsed.data.jurisdiction,
      effectiveDate: parsed.data.effectiveDate,
    });

    res.status(201).json(inserted);
  } catch (err) {
    if (err instanceof LegalDocImportGdocError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }
    log.error('POST /api/deals/:dealId/legal-documents/import-gdoc error', err);
    res.status(500).json({ error: 'Failed to import Google Doc' });
  }
});

// ============================================================
// POST /legal-documents/check-signatures — on-demand poll
// ============================================================
// ACTIVE signature-detection path: polls every SENT-but-unsigned NDA in the
// org against Google Drive and flips any that look signed to SIGNED. (The Drive
// push webhook is disabled until prod — *.vercel.app can't be GCP-verified.)
// MUST be registered BEFORE any `/legal-documents/:id...` route so Express
// doesn't match `check-signatures` as an `:id`.
router.post('/legal-documents/check-signatures', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const result = await pollOrgSignatures({ organizationId: orgId });
    res.json(result);
  } catch (err) {
    log.error('POST /api/legal-documents/check-signatures error', err);
    res.status(500).json({ error: 'Failed to check signatures' });
  }
});

// ============================================================
// PATCH /legal-documents/:id — update fields incl. content
// ============================================================

router.patch('/legal-documents/:id', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
    }

    const { data: existing, error: existsErr } = await supabase
      .from('LegalDocument')
      .select('id, organizationId')
      .eq('id', id)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existing || existing.organizationId !== orgId) {
      return res.status(404).json({ error: 'Legal document not found' });
    }

    const updatePayload: Record<string, unknown> = { ...parsed.data };
    // Sanitise content through the same allowlist used at parse time
    // so we never let raw <script> markup land on the row.
    if (typeof parsed.data.content === 'string') {
      updatePayload.content = sanitiseLegalDocHtml(parsed.data.content);
    }
    updatePayload.updatedAt = new Date().toISOString();

    const { data, error } = await supabase
      .from('LegalDocument')
      .update(updatePayload)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select('*')
      .single();
    if (error) throw error;

    res.json(data);
  } catch (err) {
    log.error('PATCH /api/legal-documents/:id error', err);
    res.status(500).json({ error: 'Failed to update legal document' });
  }
});

// ============================================================
// DELETE /legal-documents/:id — soft delete
// ============================================================

router.delete('/legal-documents/:id', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;

    const { data: existing, error: existsErr } = await supabase
      .from('LegalDocument')
      .select('id, organizationId, metadata')
      .eq('id', id)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existing || existing.organizationId !== orgId) {
      return res.status(404).json({ error: 'Legal document not found' });
    }

    const nextMetadata = {
      ...((existing.metadata as Record<string, unknown> | null) ?? {}),
      deletedAt: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('LegalDocument')
      .update({ metadata: nextMetadata, updatedAt: new Date().toISOString() })
      .eq('id', id)
      .eq('organizationId', orgId);
    if (error) throw error;

    res.status(204).send();
  } catch (err) {
    log.error('DELETE /api/legal-documents/:id error', err);
    res.status(500).json({ error: 'Failed to delete legal document' });
  }
});

// ============================================================
// POST /legal-documents/:id/send — Gmail send via Workspace OAuth
// ============================================================

router.post('/legal-documents/:id/send', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const parsed = sendBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
    }

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const result = await sendLegalDocument({
      documentId: id,
      organizationId: orgId,
      userId: internalUserId,
      senderEmailHint: req.user.email,
      toEmail: parsed.data.toEmail,
      subject: parsed.data.subject,
      message: parsed.data.message,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LegalDocSendError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }
    log.error('POST /api/legal-documents/:id/send error', err);
    res.status(500).json({ error: 'Failed to send legal document' });
  }
});

// ============================================================
// POST /legal-documents/:id/request-signature — eSignature deep-link
// ============================================================
// See legalDocSignatureService.ts for the "no programmatic API" rationale
// + forward-compat path for the eventual Google Workspace eSignature API.
router.post('/legal-documents/:id/request-signature', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const result = await requestLegalDocSignature({
      documentId: id,
      organizationId: orgId,
      userId: internalUserId,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LegalDocSignatureError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }
    log.error('POST /api/legal-documents/:id/request-signature error', err);
    res.status(500).json({ error: 'Failed to request signature' });
  }
});

// ============================================================
// GET /legal-documents/:id/export?format=docx|pdf — binary download
// ============================================================
// Streams a .docx or .pdf rendered via Google Drive's native Doc export.
// Sent docs export their persistent Google Doc; drafts get a throwaway Doc
// created → exported → deleted inside the service.
router.get('/legal-documents/:id/export', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const format = req.query.format === 'pdf' ? 'pdf' : 'docx';

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const result = await exportLegalDocument({
      documentId: id,
      organizationId: orgId,
      userId: internalUserId,
      format,
    });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.setHeader('Content-Length', String(result.bytes.length));
    res.send(result.bytes);
  } catch (err) {
    if (err instanceof LegalDocExportError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }
    log.error('GET /api/legal-documents/:id/export error', err);
    res.status(500).json({ error: 'Failed to export legal document' });
  }
});

export default router;

// ─── /api/legal-document-templates router (Phase 2) ─────────
// Templates live in-app: admins upload .docx / .html / .md, the
// /parse endpoint returns sanitized HTML, the admin marks up
// placeholders manually, then POSTs the verified template body.
//
// Read is open to any org member (so the create-NDA modal can show
// the template picker). Write — parse / create / update / delete —
// is open to authenticated org members for now.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import {
  parseTemplateFile,
  sanitiseLegalDocHtml,
  LegalDocParseError,
  type TemplateFileKind,
} from '../services/legalDocParseService.js';
import { LEGAL_DOC_TOKEN_KEYS } from '../services/legalDocSubstituteService.js';

const router = Router();

// 25 MB upload cap is generous for a Word doc; we still defer to
// the parser to throw INVALID_FILE_FORMAT if the bytes aren't real.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const DOC_TYPES = [
  'NDA', 'LOI', 'TERM_SHEET', 'DEFINITIVE_AGREEMENT', 'SIDE_LETTER', 'OTHER',
] as const;
const TOKEN_KEY_ENUM = z.enum(LEGAL_DOC_TOKEN_KEYS as readonly [string, ...string[]]);
const KIND_VALUES = ['docx', 'html', 'md', 'pdf'] as const;

const listQuerySchema = z.object({
  docType: z.enum(DOC_TYPES).optional(),
});

const parseBodySchema = z.object({
  kind: z.enum(KIND_VALUES),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(200),
  docType: z.enum(DOC_TYPES).optional(),
  bodyHtml: z.string().min(1).max(2_000_000),
  originalFileName: z.string().max(500).optional(),
  placeholderKeys: z.array(TOKEN_KEY_ENUM).default([]),
  isDefault: z.boolean().optional(),
});

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    bodyHtml: z.string().min(1).max(2_000_000).optional(),
    placeholderKeys: z.array(TOKEN_KEY_ENUM).optional(),
    isDefault: z.boolean().optional(),
    verifiedAt: z.string().datetime().nullable().optional(),
  })
  .refine(v => Object.keys(v).length > 0, { message: 'At least one field required' });

function isMissingTableError(error: { code?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205';
}

function suggestNameFromFile(filename: string | undefined): string {
  if (!filename) return 'Untitled Template';
  return filename
    .replace(/\.(docx|html|htm|md|markdown|pdf)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled Template';
}

// Defensive: if the admin marks isDefault on this template, flip any
// other default for the same (org, docType) tuple to false so the
// "default template" picker stays unambiguous.
async function clearOtherDefaults(
  orgId: string,
  docType: string,
  exceptId: string | null,
): Promise<void> {
  let q = supabase
    .from('LegalDocTemplate')
    .update({ isDefault: false, updatedAt: new Date().toISOString() })
    .eq('organizationId', orgId)
    .eq('docType', docType)
    .eq('isDefault', true);
  if (exceptId) q = q.neq('id', exceptId);
  const { error } = await q;
  if (error) {
    log.warn('legal-document-templates: failed to clear other defaults', {
      orgId, docType, exceptId, message: error.message,
    });
  }
}

// ============================================================
// GET /legal-document-templates — org-scoped read (any member)
// ============================================================

router.get('/legal-document-templates', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query', details: parsed.error.errors });
    }
    let query = supabase
      .from('LegalDocTemplate')
      .select('*')
      .eq('organizationId', orgId)
      .order('updatedAt', { ascending: false });
    if (parsed.data.docType) query = query.eq('docType', parsed.data.docType);

    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) return res.json([]);
      throw error;
    }
    res.json(data ?? []);
  } catch (err) {
    log.error('GET /api/legal-document-templates error', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// ============================================================
// POST /legal-document-templates/parse — org member upload, multipart
// ============================================================

router.post(
  '/legal-document-templates/parse',
  upload.single('file'),
  async (req, res) => {
    try {
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) {
        return res.status(400).json({
          error: 'Missing file upload',
          code: 'INVALID_FILE_FORMAT',
        });
      }
      const parsed = parseBodySchema.safeParse({ kind: req.body?.kind });
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid kind — expected docx | html | md | pdf',
          code: 'INVALID_FILE_FORMAT',
          details: parsed.error.errors,
        });
      }

      const result = await parseTemplateFile({
        buffer: file.buffer,
        kind: parsed.data.kind as TemplateFileKind,
      });

      res.json({
        draft: {
          bodyHtml: result.bodyHtml,
          originalFileName: file.originalname,
          suggestedName: suggestNameFromFile(file.originalname),
        },
      });
    } catch (err) {
      if (err instanceof LegalDocParseError) {
        return res.status(err.status).json({
          error: err.message,
          code: err.code,
          details: err.details,
        });
      }
      log.error('POST /api/legal-document-templates/parse error', err);
      res.status(500).json({ error: 'Failed to parse template' });
    }
  },
);

// ============================================================
// POST /legal-document-templates — org member save verified
// ============================================================

router.post(
  '/legal-document-templates',
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const parsed = createBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
      }

      const docType = parsed.data.docType ?? 'NDA';
      const now = new Date().toISOString();
      const sanitisedBody = sanitiseLegalDocHtml(parsed.data.bodyHtml);

      if (parsed.data.isDefault === true) {
        await clearOtherDefaults(orgId, docType, null);
      }

      const insertRow = {
        organizationId: orgId,
        name: parsed.data.name,
        docType,
        bodyHtml: sanitisedBody,
        originalFileName: parsed.data.originalFileName ?? null,
        placeholderKeys: parsed.data.placeholderKeys,
        isDefault: parsed.data.isDefault ?? false,
        uploadedAt: now,
        verifiedAt: now,
      };

      const { data, error } = await supabase
        .from('LegalDocTemplate')
        .insert(insertRow)
        .select('*')
        .single();
      if (error) throw error;

      res.status(201).json(data);
    } catch (err) {
      log.error('POST /api/legal-document-templates error', err);
      res.status(500).json({ error: 'Failed to create template' });
    }
  },
);

// ============================================================
// PATCH /legal-document-templates/:id — org member update
// ============================================================

router.patch(
  '/legal-document-templates/:id',
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const { id } = req.params;
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
      }

      const { data: existing, error: existsErr } = await supabase
        .from('LegalDocTemplate')
        .select('id, organizationId, docType')
        .eq('id', id)
        .maybeSingle();
      if (existsErr) throw existsErr;
      if (!existing || existing.organizationId !== orgId) {
        return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      }

      if (parsed.data.isDefault === true) {
        await clearOtherDefaults(orgId, existing.docType as string, id);
      }

      const updatePayload: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
      if (parsed.data.bodyHtml !== undefined) {
        updatePayload.bodyHtml = sanitiseLegalDocHtml(parsed.data.bodyHtml);
      }
      if (parsed.data.placeholderKeys !== undefined) {
        updatePayload.placeholderKeys = parsed.data.placeholderKeys;
      }
      if (parsed.data.isDefault !== undefined) updatePayload.isDefault = parsed.data.isDefault;
      if (parsed.data.verifiedAt !== undefined) {
        updatePayload.verifiedAt = parsed.data.verifiedAt;
      }
      updatePayload.updatedAt = new Date().toISOString();

      const { data, error } = await supabase
        .from('LegalDocTemplate')
        .update(updatePayload)
        .eq('id', id)
        .eq('organizationId', orgId)
        .select('*')
        .single();
      if (error) throw error;

      res.json(data);
    } catch (err) {
      log.error('PATCH /api/legal-document-templates/:id error', err);
      res.status(500).json({ error: 'Failed to update template' });
    }
  },
);

// ============================================================
// DELETE /legal-document-templates/:id — org member hard delete
// ============================================================

router.delete(
  '/legal-document-templates/:id',
  async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const { id } = req.params;

      const { data: existing, error: existsErr } = await supabase
        .from('LegalDocTemplate')
        .select('id, organizationId')
        .eq('id', id)
        .maybeSingle();
      if (existsErr) throw existsErr;
      if (!existing || existing.organizationId !== orgId) {
        return res.status(404).json({ error: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
      }

      const { error } = await supabase
        .from('LegalDocTemplate')
        .delete()
        .eq('id', id)
        .eq('organizationId', orgId);
      if (error) throw error;

      res.status(204).send();
    } catch (err) {
      log.error('DELETE /api/legal-document-templates/:id error', err);
      res.status(500).json({ error: 'Failed to delete template' });
    }
  },
);

export default router;

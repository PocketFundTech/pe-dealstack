// ─── NDA review routes ────────────────────────────────────────────
// Review an INCOMING counterparty NDA against the firm's playbook:
//   POST /api/deals/:dealId/nda-reviews   — upload a file, or point at a
//                                           document already in the VDR
//   GET  /api/deals/:dealId/nda-reviews   — history for a deal
//   GET  /api/nda-reviews/:id             — one review in full
//
// Runs trackedClaudeMessage, so pickBundle routes /api/deals/:id/nda-reviews
// to the AI bundle — this router must be mounted in app-ai.ts.
//
// Parsing is delegated to legalDocParseService (the same docx/pdf/html/md
// path the existing NDA import uses) so there is one parser in the codebase.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { downloadFileBuffer } from '../utils/storage.js';
import {
  parseTemplateFile,
  LegalDocParseError,
  type TemplateFileKind,
} from '../services/legalDocParseService.js';
import { reviewNda, NdaReviewError } from '../services/agents/ndaReview/index.js';
import { AIRefusalError } from '../services/ai/client.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const bodySchema = z.object({
  documentId: z.string().uuid().optional(),
});

const EXTENSION_KINDS: Record<string, TemplateFileKind> = {
  pdf: 'pdf', docx: 'docx', html: 'html', htm: 'html', md: 'md', markdown: 'md',
};

/** Map a filename to a parser kind, or null if we can't read it. */
function kindForFile(fileName: string): TemplateFileKind | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_KINDS[ext] ?? null;
}

/** One place to turn an engine/parser failure into an honest status code. */
function sendReviewError(res: Response, error: unknown) {
  if (error instanceof LegalDocParseError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (error instanceof NdaReviewError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof AIRefusalError || (error as Error)?.name === 'AIRefusalError') {
    // A refusal is a content outcome, not a server fault.
    return res.status(422).json({
      error: 'The model declined to review this document.',
      code: 'AI_REFUSED',
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) {
    return res.status(504).json({ error: 'The review took too long. Try again.', code: 'TIMEOUT' });
  }
  log.error('NDA review failed', { error: message });
  return res.status(500).json({ error: 'Failed to review this NDA' });
}

// POST /api/deals/:dealId/nda-reviews
router.post(
  '/deals/:dealId/nda-reviews',
  (req: Request, res: Response, next: (err?: unknown) => void) => {
    // Same edge-handling as doc-request-portal: a multer reject is a 400
    // about the file, not a 500 about us.
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err) return next();
      const message = err instanceof Error ? err.message : 'Upload rejected';
      res.status(400).json({ error: message });
    });
  },
  async (req: Request, res: Response) => {
    const parsedBody = bodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsedBody.error.flatten() });
    }

    try {
      const { dealId } = req.params;
      const orgId = getOrgId(req);
      const deal = await verifyDealAccess(dealId, orgId);
      if (!deal) return res.status(404).json({ error: 'Deal not found' });

      let buffer: Buffer;
      let fileName: string;
      let documentId: string | null = null;

      if (req.file) {
        buffer = req.file.buffer;
        fileName = req.file.originalname;
      } else if (parsedBody.data.documentId) {
        const { data: doc } = await supabase
          .from('Document')
          .select('id, dealId, name, fileUrl')
          .eq('id', parsedBody.data.documentId)
          .single();

        // Scope to this deal — a document id from elsewhere must look
        // identical to one that doesn't exist.
        if (!doc || doc.dealId !== dealId || !doc.fileUrl) {
          return res.status(404).json({ error: 'Not found' });
        }

        const downloaded = await downloadFileBuffer(doc.fileUrl);
        if (!downloaded) {
          return res.status(404).json({ error: 'That document could not be read.' });
        }
        buffer = downloaded;
        fileName = doc.name;
        documentId = doc.id;
      } else {
        return res.status(400).json({ error: 'Attach a file or choose a document from the data room.' });
      }

      const kind = kindForFile(fileName);
      if (!kind) {
        return res.status(400).json({
          error: 'Unsupported file type. Upload a PDF, Word document, HTML or Markdown file.',
          code: 'UNSUPPORTED_FILE_TYPE',
        });
      }

      const { bodyHtml } = await parseTemplateFile({ buffer, kind });

      const review = await reviewNda({
        orgId,
        dealId,
        documentId,
        sourceHtml: bodyHtml,
        sourceFileName: fileName,
        createdBy: (req as any).user?.id ?? null,
      });

      res.status(201).json(review);
    } catch (error) {
      sendReviewError(res, error);
    }
  },
);

// GET /api/deals/:dealId/nda-reviews — history (summary fields only)
router.get('/deals/:dealId/nda-reviews', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const deal = await verifyDealAccess(dealId, orgId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    // sourceHtml is deliberately excluded — it's a whole contract per row.
    const { data: reviews, error } = await supabase
      .from('NdaReview')
      .select('id, sourceFileName, summary, riskLevel, model, reviewedAt, findings')
      .eq('dealId', dealId)
      .eq('organizationId', orgId)
      .order('reviewedAt', { ascending: false })
      .limit(25);
    if (error) throw error;

    res.json({
      reviews: (reviews ?? []).map((r) => ({
        id: r.id,
        sourceFileName: r.sourceFileName,
        summary: r.summary,
        riskLevel: r.riskLevel,
        model: r.model,
        reviewedAt: r.reviewedAt,
        findingCount: Array.isArray(r.findings) ? r.findings.length : 0,
        dealBreakerCount: Array.isArray(r.findings)
          ? r.findings.filter((f: { status?: string }) => f.status === 'DEAL_BREAKER').length
          : 0,
      })),
    });
  } catch (error: any) {
    log.error('List NDA reviews failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load NDA reviews' });
  }
});

// GET /api/nda-reviews/:id — one review in full
router.get('/nda-reviews/:id', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { data: review, error } = await supabase
      .from('NdaReview')
      .select('id, dealId, sourceFileName, summary, riskLevel, findings, playbookSnapshot, model, reviewedAt')
      .eq('id', req.params.id)
      .eq('organizationId', orgId)
      .single();

    if (error || !review) return res.status(404).json({ error: 'Review not found' });
    res.json({ review });
  } catch (error: any) {
    log.error('Get NDA review failed', { error: error.message });
    res.status(500).json({ error: 'Failed to load this review' });
  }
});

export default router;

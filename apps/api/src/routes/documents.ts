import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess, verifyDocumentAccess, verifyFolderAccess } from '../middleware/orgScope.js';
import { getSignedDownloadUrl, extractStoragePath, downloadFileBuffer } from '../utils/storage.js';

// Sub-routers
import documentsUploadRouter from './documents-upload.js';
import documentsSharingRouter from './documents-sharing.js';

const router = Router();

// Mount sub-routers
router.use('/', documentsUploadRouter);
router.use('/', documentsSharingRouter);

// ─── Validation Schemas ─────────────────────────────────────────

// Document type enum
const documentTypes = ['CIM', 'TEASER', 'FINANCIALS', 'LEGAL', 'NDA', 'LOI', 'EMAIL', 'PDF', 'EXCEL', 'DOC', 'OTHER'] as const;

const createDocumentSchema = z.object({
  name: z.string().min(1),
  type: z.enum(documentTypes).default('OTHER'),
  folderId: z.string().uuid().optional().nullable(),
  extractedData: z.record(z.any()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  aiAnalysis: z.object({
    type: z.string(),
    label: z.string(),
    description: z.string(),
    color: z.string(),
  }).optional(),
  tags: z.array(z.string()).optional(),
  isHighlighted: z.boolean().optional(),
});

const updateDocumentSchema = createDocumentSchema.partial();

const documentsQuerySchema = z.object({
  type: z.enum(documentTypes).optional(),
  folderId: z.string().optional(),
  tags: z.string().max(500).optional(),
  search: z.string().max(200).optional(),
});

// Resolve Document.uploadedBy → { id, name, avatar } via a batched query and
// attach it as `uploader` (null when unknown). This replaces the PostgREST
// embed `uploader:User!uploadedBy(...)`, which 500s with PGRST200 because
// Document.uploadedBy has no FK to User (see vdr-schema.sql). Once the FK is
// added by foreign-keys-migration.sql the embed would work too, but resolving
// it here keeps the endpoint correct regardless of DB constraint state.
async function attachUploaders<T extends { uploadedBy?: string | null }>(
  rows: T[],
): Promise<Array<T & { uploader: { id: string; name: string | null; avatar: string | null } | null }>> {
  const ids = [...new Set(
    rows.map((d) => d.uploadedBy).filter((id): id is string => !!id),
  )];
  if (ids.length === 0) {
    return rows.map((d) => ({ ...d, uploader: null }));
  }
  const { data: users, error } = await supabase
    .from('User')
    .select('id, name, avatar')
    .in('id', ids);
  if (error) throw error;
  const byId = new Map((users || []).map((u: any) => [u.id, u]));
  return rows.map((d) => ({ ...d, uploader: byId.get(d.uploadedBy as string) ?? null }));
}

// ─── GET /api/deals/:dealId/documents — List documents for a deal ───

router.get('/deals/:dealId/documents', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { type, folderId, tags, search } = documentsQuerySchema.parse(req.query);

    // NOTE: `uploader` is resolved with a separate query rather than the
    // PostgREST embed `uploader:User!uploadedBy(...)`. Document.uploadedBy has
    // no FK to User (see vdr-schema.sql), so the embed raises PGRST200 and 500s.
    // The folder embed is kept — its FK (Document.folderId → Folder) exists.
    let query = supabase
      .from('Document')
      .select(`
        *,
        folder:Folder!folderId(id, name)
      `)
      .eq('dealId', dealId)
      .order('createdAt', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }

    if (folderId) {
      if (folderId === 'null') {
        query = query.is('folderId', null);
      } else {
        query = query.eq('folderId', folderId);
      }
    }

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    const rows = await attachUploaders(data || []);

    // Filter by tags if provided (client-side for now)
    let filteredData = rows;
    if (tags) {
      const tagArray = (tags as string).split(',');
      filteredData = filteredData.filter((doc: any) =>
        doc.tags && tagArray.some((tag: string) => doc.tags.includes(tag))
      );
    }

    res.json(filteredData);
  } catch (error) {
    log.error('Error fetching documents', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ─── GET /api/folders/:folderId/documents — List documents in a folder ───

router.get('/folders/:folderId/documents', async (req, res) => {
  try {
    const { folderId } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(folderId, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { type, search } = req.query;

    let query = supabase
      .from('Document')
      .select('*')
      .eq('folderId', folderId)
      .order('createdAt', { ascending: false });

    if (type) {
      query = query.eq('type', type);
    }

    if (search) {
      query = query.ilike('name', `%${search}%`);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json(await attachUploaders(data || []));
  } catch (error) {
    log.error('Error fetching folder documents', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ─── GET /api/documents/:id — Get single document ───

router.get('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const docAccess = await verifyDocumentAccess(id, orgId);
    if (!docAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { data, error } = await supabase
      .from('Document')
      .select(`
        *,
        deal:Deal(id, name, stage)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Document not found' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    log.error('Error fetching document', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// ─── PATCH /api/documents/:id — Update document metadata ───

router.patch('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const docAccess = await verifyDocumentAccess(id, orgId);
    if (!docAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const data = updateDocumentSchema.parse(req.body);

    // Add updatedAt timestamp
    const updateData: any = {
      ...data,
      updatedAt: new Date().toISOString(),
    };

    // If aiAnalysis is provided, update aiAnalyzedAt
    if (data.aiAnalysis) {
      updateData.aiAnalyzedAt = new Date().toISOString();
    }

    const { data: document, error } = await supabase
      .from('Document')
      .update(updateData)
      .eq('id', id)
      .select(`
        *,
        folder:Folder!folderId(id, name)
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Document not found' });
      }
      throw error;
    }

    const [withUploader] = await attachUploaders([document]);
    res.json(withUploader);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error updating document', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// ─── DELETE /api/documents/:id — Delete document ───

router.delete('/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const docAccess = await verifyDocumentAccess(id, orgId);
    if (!docAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Get document to find file path
    const { data: doc, error: fetchError } = await supabase
      .from('Document')
      .select('fileUrl, dealId, name')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Document not found' });
      }
      throw fetchError;
    }

    // Delete from storage if file exists
    if (doc.fileUrl) {
      try {
        const storagePath = extractStoragePath(doc.fileUrl);
        await supabase.storage.from('documents').remove([storagePath]);
      } catch (storageError) {
        log.error('Error deleting from storage', storageError);
        // Continue even if storage deletion fails
      }
    }

    // Delete document record
    const { error } = await supabase
      .from('Document')
      .delete()
      .eq('id', id);

    if (error) throw error;

    // Audit log
    await AuditLog.documentDeleted(req, id, doc.name);

    res.status(204).send();
  } catch (error) {
    log.error('Error deleting document', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ─── GET /api/documents/:id/download — Get signed download URL ───

// 25 MB cap on watermarking — beyond this, fall back to passthrough so the
// serverless function doesn't OOM trying to load the whole PDF in memory.
const WATERMARK_MAX_BYTES = 25 * 1024 * 1024;

router.get('/documents/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const docAccess = await verifyDocumentAccess(id, orgId);
    if (!docAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { data: doc, error: fetchError } = await supabase
      .from('Document')
      .select('fileUrl, name, mimeType, fileSize')
      .eq('id', id)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!doc.fileUrl) {
      return res.status(404).json({ error: 'No file associated with this document' });
    }

    const isPdf = (doc.mimeType ?? '').toLowerCase() === 'application/pdf' ||
      (doc.name ?? '').toLowerCase().endsWith('.pdf');
    const sizeOk =
      typeof doc.fileSize !== 'number' || doc.fileSize <= WATERMARK_MAX_BYTES;
    const viewerEmail = req.user?.email ?? 'unknown@pocket-fund.com';
    const viewerIp = req.ip ?? null;

    if (isPdf && sizeOk) {
      try {
        const storagePath = extractStoragePath(doc.fileUrl);
        const buffer = await downloadFileBuffer(storagePath);
        if (!buffer) {
          throw new Error('Storage download returned null');
        }
        const { watermarkPdf } = await import('../services/pdfWatermark.js');
        const stamped = await watermarkPdf(buffer, {
          email: viewerEmail,
          ip: viewerIp,
          timestamp: new Date(),
        });

        // Audit-log the download as watermarked
        AuditLog.documentDownloaded(req, id, doc.name, {
          watermarked: true,
        }).catch(() => {});

        const safeName = (doc.name ?? 'document.pdf').replace(/"/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        res.setHeader('X-Watermarked', '1');
        res.setHeader('Content-Length', String(stamped.length));
        return res.end(stamped);
      } catch (wmErr) {
        // Fall through to the passthrough JSON response so the user still
        // gets their file. Log so we can investigate failures.
        log.warn('PDF watermark failed; falling back to passthrough', {
          docId: id,
          err: wmErr instanceof Error ? wmErr.message : String(wmErr),
        });
      }
    }

    // Passthrough: non-PDF, oversized PDF, or watermark error.
    const signedUrl = await getSignedDownloadUrl(doc.fileUrl);
    if (!signedUrl) {
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    AuditLog.documentDownloaded(req, id, doc.name, {
      watermarked: false,
      watermarkSkipReason: !isPdf
        ? 'not_pdf'
        : !sizeOk
          ? 'size_limit'
          : 'fallback',
    }).catch(() => {});

    return res.json({
      url: signedUrl,
      name: doc.name,
    });
  } catch (error) {
    log.error('Error getting download URL', error);
    return res.status(500).json({ error: 'Failed to get download URL' });
  }
});

// ─── POST /api/documents/:id/analyze — Re-analyze a document ───

router.post('/documents/:id/analyze', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const docAccess = await verifyDocumentAccess(id, orgId);
    if (!docAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Fetch document record
    const { data: doc, error: fetchError } = await supabase
      .from('Document')
      .select('id, name, fileUrl, mimeType, dealId')
      .eq('id', id)
      .single();

    if (fetchError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!doc.fileUrl) {
      return res.status(400).json({ error: 'No file stored for this document' });
    }

    // Download file from Supabase Storage
    const storagePath = extractStoragePath(doc.fileUrl);
    const { data: fileData, error: dlError } = await supabase.storage
      .from('documents')
      .download(storagePath);

    if (dlError || !fileData) {
      log.error('Failed to download file for re-analysis', { id, error: dlError });
      return res.status(500).json({ error: 'Failed to download file' });
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    let extractedText: string | null = null;

    // Route by file type (lazy-load parsers so lite bundle stays light)
    const { extractTextFromPDF } = await import('../services/pdfExtractor.js');
    const { excelToMarkdown } = await import('../services/excelToMarkdown.js');
    const { isExcelFile } = await import('../services/excelFinancialExtractor.js');
    if (doc.mimeType === 'application/pdf') {
      const pdfResult = await extractTextFromPDF(buffer);
      extractedText = pdfResult?.text?.replace(/\u0000/g, '') || null;
    } else if (isExcelFile(doc.mimeType, doc.name)) {
      extractedText = excelToMarkdown(buffer)?.replace(/\u0000/g, '') || null;
    }

    if (!extractedText) {
      return res.status(422).json({
        error: 'Could not extract text from this file type. Only PDF and Excel files are supported.',
      });
    }

    // Update document with extracted text
    const { data: updated, error: updateError } = await supabase
      .from('Document')
      .update({
        extractedText,
        status: 'completed',
        updatedAt: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) throw updateError;

    // Trigger RAG embedding (fire-and-forget)
    const { embedDocument } = await import('../rag.js');
    embedDocument(id, doc.dealId, extractedText).catch(err =>
      log.error('RAG re-analyze embed error', err)
    );

    log.info('Document re-analyzed', { id, name: doc.name, textLength: extractedText.length });

    res.json(updated);
  } catch (error) {
    log.error('Error re-analyzing document', error);
    res.status(500).json({ error: 'Failed to analyze document' });
  }
});

export default router;

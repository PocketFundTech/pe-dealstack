// POST /api/legal-documents/:id/send-for-signature
//
// Sends a LegalDocument to the counterparty as a locked Dropbox Sign
// signature request (PDF), instead of sharing an editable Google Doc link.
// Mounted under /api with the same auth/org middleware stack as the rest of
// legalDocumentsRouter, but kept in its own file because legal-documents.ts
// already exceeds the 500-line cap.

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import {
  sendLegalDocForSignature,
  LegalDocEsignError,
} from '../services/legalDocEsignService.js';

const router = Router();

const bodySchema = z.object({
  toEmail: z.string().email().max(500).optional(),
  signerName: z.string().max(500).optional(),
  subject: z.string().max(500).optional(),
  message: z.string().max(20_000).optional(),
});

async function resolveInternalUserId(authId: string): Promise<string | null> {
  const { data } = await supabase
    .from('User')
    .select('id')
    .eq('authId', authId)
    .single();
  return data?.id ?? null;
}

router.post('/legal-documents/:id/send-for-signature', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { id } = req.params;
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid data', details: parsed.error.errors });
    }

    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const internalUserId = await resolveInternalUserId(req.user.id);
    if (!internalUserId) return res.status(404).json({ error: 'User not found' });

    const result = await sendLegalDocForSignature({
      documentId: id,
      organizationId: orgId,
      userId: internalUserId,
      toEmail: parsed.data.toEmail,
      signerName: parsed.data.signerName,
      subject: parsed.data.subject,
      message: parsed.data.message,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof LegalDocEsignError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }
    log.error('POST /api/legal-documents/:id/send-for-signature error', err);
    res.status(500).json({ error: 'Failed to send document for signature' });
  }
});

export default router;

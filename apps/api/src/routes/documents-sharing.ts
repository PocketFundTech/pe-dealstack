import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { Resend } from 'resend';
import { log } from '../utils/logger.js';
import { notifyDealTeam, resolveUserId } from './notifications.js';
import { getOrgId, verifyDealAccess, verifyDocumentAccess } from '../middleware/orgScope.js';

// Initialize Resend for document request emails
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const router = Router();

// POST /api/documents/:id/link - Link (copy) a document to another deal
router.post('/documents/:id/link', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const schema = z.object({
      targetDealId: z.string().uuid(),
    });
    const { targetDealId } = schema.parse(req.body);

    // SECURITY: both the source document and the target deal must belong to the
    // caller's organization. Without these checks any authenticated user could
    // copy another tenant's document (and its extracted financials) into their
    // own deal, or inject a document into another tenant's deal.
    const sourceAccess = await verifyDocumentAccess(id, orgId);
    if (!sourceAccess) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const targetDeal = await verifyDealAccess(targetDealId, orgId);
    if (!targetDeal) {
      return res.status(404).json({ error: 'Target deal not found' });
    }

    // Fetch the full original document (verifyDocumentAccess returns only id/dealId)
    const { data: original, error: fetchErr } = await supabase
      .from('Document')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !original) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Create new Document row pointing at same storage file
    const { data: linked, error: insertErr } = await supabase
      .from('Document')
      .insert({
        dealId: targetDealId,
        folderId: null, // No folder assignment on target deal
        uploadedBy: original.uploadedBy,
        name: original.name,
        type: original.type,
        fileUrl: original.fileUrl,
        fileSize: original.fileSize,
        mimeType: original.mimeType,
        extractedData: original.extractedData,
        extractedText: original.extractedText,
        status: original.status,
        confidence: original.confidence,
        aiAnalysis: original.aiAnalysis,
        aiAnalyzedAt: original.aiAnalyzedAt,
        tags: original.tags,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // If original had extracted data, merge into target deal
    if (original.extractedData) {
      try {
        const { mergeIntoExistingDeal } = await import('../services/dealMerger.js');
        await mergeIntoExistingDeal(targetDealId, original.extractedData, (req as any).user?.id, original.name);
        log.info('Target deal auto-updated from linked document', { targetDealId, documentName: original.name });
      } catch (mergeError) {
        log.error('Failed to auto-update target deal from linked doc', mergeError);
      }
    }

    // Log activity on target deal
    await supabase.from('Activity').insert({
      dealId: targetDealId,
      type: 'DOCUMENT_ADDED',
      title: `Document linked: ${original.name}`,
      description: `Document "${original.name}" linked from another deal's data room`,
      metadata: { sourceDealId: original.dealId, documentId: linked.id },
    });

    // Notify target deal team: document linked (fire-and-forget)
    if (req.user?.id) {
      resolveUserId(req.user.id).then(internalId => {
        notifyDealTeam(
          targetDealId, 'DOCUMENT_UPLOADED',
          `Document linked: ${original.name}`,
          `Linked from another deal's data room`,
          internalId || undefined
        );
      }).catch(err => log.error('Notification error (doc link)', err));
    }

    res.status(201).json(linked);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error linking document', error);
    res.status(500).json({ error: 'Failed to link document' });
  }
});

// POST /deals/:dealId/document-requests — Request a missing document (email + in-app notification)
router.post('/deals/:dealId/document-requests', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { documentName, folderId, folderName } = z.object({
      documentName: z.string().min(1).max(255),
      folderId: z.string().optional(),
      folderName: z.string().optional(),
    }).parse(req.body);

    // Get requester info
    const internalUserId = req.user?.id ? await resolveUserId(req.user.id) : null;
    let requesterName = 'A team member';
    if (internalUserId) {
      const { data: user } = await supabase
        .from('User')
        .select('fullName, email')
        .eq('id', internalUserId)
        .single();
      if (user?.fullName) requesterName = user.fullName;
    }

    // Get deal info
    const { data: deal } = await supabase
      .from('Deal')
      .select('name, companyName')
      .eq('id', dealId)
      .single();
    const dealName = deal?.name || deal?.companyName || 'a deal';

    // Get deal team members' emails for notification
    const { data: teamMembers } = await supabase
      .from('DealTeamMember')
      .select('userId, role, user:User!userId(id, fullName, email)')
      .eq('dealId', dealId);

    const recipientEmails = (teamMembers || [])
      .filter(tm => tm.userId !== internalUserId && (tm.user as any)?.email)
      .map(tm => (tm.user as any).email as string);

    // Send email to team members (if Resend is configured)
    let emailSent = false;
    if (resend && recipientEmails.length > 0) {
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
      const baseUrl = process.env.APP_URL || 'http://localhost:3000';
      const vdrUrl = `${baseUrl}/vdr.html?dealId=${dealId}`;

      try {
        await resend.emails.send({
          from: `PE OS <${fromEmail}>`,
          to: recipientEmails,
          subject: `Document Requested: ${documentName} — ${dealName}`,
          html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
              <div style="background: linear-gradient(135deg, #003366, #0055aa); padding: 32px; text-align: center; border-radius: 8px 8px 0 0;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">PE OS</h1>
                <p style="color: #b3d1ff; margin: 8px 0 0; font-size: 14px;">Document Request</p>
              </div>
              <div style="padding: 32px;">
                <h2 style="color: #003366; margin: 0 0 16px; font-size: 20px;">Document Requested</h2>
                <p style="color: #333; font-size: 16px; line-height: 1.6;">
                  <strong>${requesterName}</strong> has requested the following document for <strong>${dealName}</strong>:
                </p>
                <div style="background: #f8f9fa; border-left: 4px solid #003366; padding: 16px 20px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                  <p style="color: #003366; font-size: 18px; font-weight: 600; margin: 0;">${documentName}</p>
                  ${folderName ? `<p style="color: #666; font-size: 14px; margin: 8px 0 0;">Folder: ${folderName}</p>` : ''}
                </div>
                <div style="text-align: center; margin: 32px 0;">
                  <a href="${vdrUrl}"
                     style="background: linear-gradient(135deg, #003366, #0055aa); color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 16px; font-weight: 600;">
                    Open Data Room
                  </a>
                </div>
              </div>
              <hr style="border: none; border-top: 1px solid #eef2f7; margin: 0;" />
              <div style="padding: 20px 32px; text-align: center;">
                <p style="color: #aaa; font-size: 12px; margin: 0;">
                  PE OS — AI-Powered Private Equity CRM
                </p>
              </div>
            </div>
          `,
        });
        emailSent = true;
        log.info('Document request email sent', { dealId, documentName, recipients: recipientEmails.length });
      } catch (emailError) {
        log.error('Failed to send document request email', emailError);
      }
    } else if (!resend) {
      log.warn('Resend not configured — document request email skipped');
    }

    // Send in-app notification to deal team
    notifyDealTeam(
      dealId,
      'DOCUMENT_UPLOADED', // Reuse existing type — closest match
      `Document requested: ${documentName}`,
      `${requesterName} requested "${documentName}" for the ${folderName || 'data room'}`,
      internalUserId || undefined
    ).catch(err => log.error('Notification error (doc request)', err));

    // Log activity
    await supabase.from('Activity').insert({
      dealId,
      type: 'DOCUMENT_ADDED',
      title: `Document requested: ${documentName}`,
      description: `${requesterName} requested "${documentName}" to be uploaded${folderName ? ` to ${folderName}` : ''}`,
      metadata: { documentName, folderId, requestedBy: internalUserId },
    });

    res.json({
      success: true,
      emailSent,
      recipientCount: recipientEmails.length,
      message: emailSent
        ? `Request sent to ${recipientEmails.length} team member${recipientEmails.length !== 1 ? 's' : ''}`
        : recipientEmails.length > 0
          ? 'In-app notification sent (email service not configured)'
          : 'Request logged (no other team members found)',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Error requesting document', error);
    res.status(500).json({ error: 'Failed to send document request' });
  }
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyFolderAccess } from '../middleware/orgScope.js';

const router = Router();

// GET /api/folders/:id/insights - Get folder insights
router.get('/folders/:id/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(id, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { data: insights, error } = await supabase
      .from('FolderInsight')
      .select('*')
      .eq('folderId', id)
      .order('generatedAt', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'No insights found for this folder' });
      }
      throw error;
    }

    res.json(insights);
  } catch (error) {
    next(error);
  }
});

// POST /api/folders/:id/insights - Create/update folder insights
router.post('/folders/:id/insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(id, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { summary, completionPercent, redFlags, missingDocuments } = req.body;

    // Upsert insight (delete old, insert new)
    await supabase
      .from('FolderInsight')
      .delete()
      .eq('folderId', id);

    const { data: insight, error } = await supabase
      .from('FolderInsight')
      .insert({
        folderId: id,
        summary,
        completionPercent: completionPercent || 0,
        redFlags: redFlags || [],
        missingDocuments: missingDocuments || [],
        generatedAt: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(insight);
  } catch (error) {
    next(error);
  }
});

// POST /api/folders/:id/generate-insights - AI-generate folder insights
router.post('/folders/:id/generate-insights', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: folderId } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(folderId, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // 1. Get folder info + its deal
    const { data: folder, error: folderError } = await supabase
      .from('Folder')
      .select('id, name, dealId, description')
      .eq('id', folderId)
      .single();

    if (folderError || !folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // 2. Get deal context
    const { data: deal } = await supabase
      .from('Deal')
      .select('name, companyName, industry, stage, revenue, ebitda')
      .eq('id', folder.dealId)
      .single();

    // 3. Get all documents in this folder
    const { data: documents } = await supabase
      .from('Document')
      .select('id, name, mimeType, fileSize, aiAnalysis, createdAt')
      .eq('folderId', folderId)
      .order('createdAt', { ascending: false });

    // 4. Format documents for AI
    const formattedDocs = (documents || []).map(doc => {
      let sizeStr = '0 KB';
      if (doc.fileSize) {
        sizeStr = doc.fileSize >= 1024 * 1024
          ? `${(doc.fileSize / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.round(doc.fileSize / 1024)} KB`;
      }

      const mimeType = doc.mimeType || '';
      let type = 'other';
      if (mimeType.includes('pdf')) type = 'PDF';
      else if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) type = 'Excel';
      else if (mimeType.includes('word') || mimeType.includes('document')) type = 'Word';

      return {
        name: doc.name,
        type,
        size: sizeStr,
        aiAnalysisSummary: doc.aiAnalysis?.description || doc.aiAnalysis?.summary || undefined,
        createdAt: doc.createdAt,
      };
    });

    // 5. Call AI to generate insights
    const { generateFolderInsights } = await import('../services/folderInsightsGenerator.js');
    const insights = await generateFolderInsights(
      folder.name,
      {
        dealName: deal?.name || deal?.companyName || 'Unknown Deal',
        industry: deal?.industry || undefined,
        stage: deal?.stage || undefined,
        revenue: deal?.revenue || undefined,
        ebitda: deal?.ebitda || undefined,
      },
      formattedDocs
    );

    if (!insights) {
      return res.status(503).json({ error: 'AI insights generation unavailable. Check that OPENAI_API_KEY is configured.' });
    }

    // 6. Save to FolderInsight table (upsert: delete old, insert new)
    await supabase
      .from('FolderInsight')
      .delete()
      .eq('folderId', folderId);

    const { data: savedInsight, error: insertError } = await supabase
      .from('FolderInsight')
      .insert({
        folderId,
        summary: insights.summary,
        completionPercent: insights.completionPercent,
        redFlags: insights.redFlags,
        missingDocuments: insights.missingDocuments,
        generatedAt: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      log.error('Failed to save folder insights', insertError);
      throw insertError;
    }

    log.info('AI folder insights generated and saved', { folderId, completionPercent: insights.completionPercent });
    res.status(201).json(savedInsight);
  } catch (error) {
    next(error);
  }
});

export default router;

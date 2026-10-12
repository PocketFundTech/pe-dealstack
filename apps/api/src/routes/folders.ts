import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId, verifyDealAccess, verifyFolderAccess } from '../middleware/orgScope.js';
import foldersInsightsRouter from './folders-insights.js';

const router = Router();

// Mount insights sub-router
router.use('/', foldersInsightsRouter);

/** True when folder `folderId` belongs to deal `dealId`. */
async function folderInDeal(folderId: string, dealId: string): Promise<boolean> {
  const { data } = await supabase
    .from('Folder')
    .select('id')
    .eq('id', folderId)
    .eq('dealId', dealId)
    .maybeSingle();
  return !!data;
}

// Validation schemas
const createFolderSchema = z.object({
  dealId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  isRestricted: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  isRestricted: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  parentId: z.string().uuid().nullable().optional(),
});

// GET /api/deals/:dealId/folders - List all folders for a deal
router.get('/deals/:dealId/folders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const { parentId } = req.query;

    let query = supabase
      .from('Folder')
      .select(`
        *,
        FolderInsight (
          id,
          summary,
          completionPercent,
          redFlags,
          missingDocuments,
          generatedAt
        )
      `)
      .eq('dealId', dealId)
      .order('sortOrder', { ascending: true })
      .order('name', { ascending: true });

    // Filter by parent folder if specified
    if (parentId === 'null' || parentId === '') {
      query = query.is('parentId', null);
    } else if (parentId) {
      query = query.eq('parentId', parentId);
    }

    const { data: folders, error } = await query;

    if (error) throw error;

    // Get document counts for each folder
    const folderIds = folders?.map(f => f.id) || [];
    if (folderIds.length > 0) {
      const { data: counts, error: countError } = await supabase
        .from('Document')
        .select('folderId')
        .in('folderId', folderIds);

      if (!countError && counts) {
        const countMap: Record<string, number> = {};
        counts.forEach(doc => {
          if (doc.folderId) {
            countMap[doc.folderId] = (countMap[doc.folderId] || 0) + 1;
          }
        });

        folders?.forEach(folder => {
          folder.fileCount = countMap[folder.id] || 0;
        });
      }
    }

    res.json(folders || []);
  } catch (error) {
    next(error);
  }
});

// GET /api/folders/:id - Get a single folder with insights
router.get('/folders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(id, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { data: folder, error } = await supabase
      .from('Folder')
      .select(`
        *,
        FolderInsight (
          id,
          summary,
          completionPercent,
          redFlags,
          missingDocuments,
          generatedAt
        ),
        Document (
          id,
          name,
          type,
          fileSize,
          aiAnalysis,
          createdAt
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Folder not found' });
      }
      throw error;
    }

    res.json(folder);
  } catch (error) {
    next(error);
  }
});

// POST /api/deals/:dealId/folders - Create a new folder
router.post('/deals/:dealId/folders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const validation = createFolderSchema.safeParse({ ...req.body, dealId });

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    const folderData = validation.data;

    // SECURITY: a parent folder must belong to the same deal.
    if (folderData.parentId && !(await folderInDeal(folderData.parentId, dealId))) {
      return res.status(400).json({ error: 'Invalid parentId' });
    }

    // Get the max sortOrder for this deal if not specified
    if (folderData.sortOrder === undefined) {
      const { data: existing } = await supabase
        .from('Folder')
        .select('sortOrder')
        .eq('dealId', dealId)
        .is('parentId', folderData.parentId || null)
        .order('sortOrder', { ascending: false })
        .limit(1);

      folderData.sortOrder = existing && existing[0] ? existing[0].sortOrder + 1 : 0;
    }

    const { data: folder, error } = await supabase
      .from('Folder')
      .insert(folderData)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(folder);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/folders/:id - Update a folder
router.patch('/folders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(id, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const validation = updateFolderSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors
      });
    }

    // SECURITY: re-parenting is only allowed within the folder's own deal.
    if (validation.data.parentId && !(await folderInDeal(validation.data.parentId, folderAccess.dealId))) {
      return res.status(400).json({ error: 'Invalid parentId' });
    }

    const { data: folder, error } = await supabase
      .from('Folder')
      .update({
        ...validation.data,
        updatedAt: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Folder not found' });
      }
      throw error;
    }

    res.json(folder);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/folders/:id - Delete a folder (and its contents)
router.delete('/folders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const folderAccess = await verifyFolderAccess(id, orgId);
    if (!folderAccess) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const { cascade } = req.query;

    // Check if folder has children
    const { data: children } = await supabase
      .from('Folder')
      .select('id')
      .eq('parentId', id);

    if (children && children.length > 0 && cascade !== 'true') {
      return res.status(400).json({
        error: 'Folder has subfolders. Use cascade=true to delete all.',
        childCount: children.length
      });
    }

    // Check if folder has documents
    const { data: docs } = await supabase
      .from('Document')
      .select('id')
      .eq('folderId', id);

    if (docs && docs.length > 0 && cascade !== 'true') {
      return res.status(400).json({
        error: 'Folder has documents. Use cascade=true to delete all.',
        documentCount: docs.length
      });
    }

    // If cascade, delete children and documents first
    if (cascade === 'true') {
      // Delete documents in folder
      await supabase
        .from('Document')
        .delete()
        .eq('folderId', id);

      // Recursively delete child folders (simplified - just unset parentId)
      await supabase
        .from('Folder')
        .delete()
        .eq('parentId', id);
    }

    // Delete folder insights
    await supabase
      .from('FolderInsight')
      .delete()
      .eq('folderId', id);

    // Delete the folder
    const { error } = await supabase
      .from('Folder')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/deals/:dealId/folders/init - Initialize default folders for a deal
router.post('/deals/:dealId/folders/init', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const dealAccess = await verifyDealAccess(dealId, orgId);
    if (!dealAccess) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    // Check if deal already has folders
    const { data: existingFolders } = await supabase
      .from('Folder')
      .select('id')
      .eq('dealId', dealId)
      .limit(1);

    if (existingFolders && existingFolders.length > 0) {
      // Already has folders, return them
      const { data: folders, error } = await supabase
        .from('Folder')
        .select('*')
        .eq('dealId', dealId)
        .order('sortOrder', { ascending: true });

      if (error) throw error;
      return res.json({ created: false, folders });
    }

    // Create default VDR folders
    const defaultFolders = [
      { name: '100 Financials', sortOrder: 100, description: 'Financial statements, projections, and analysis' },
      { name: '200 Legal', sortOrder: 200, description: 'Legal documents, contracts, and agreements' },
      { name: '300 Commercial', sortOrder: 300, description: 'Commercial due diligence materials' },
      { name: '400 HR & Data', sortOrder: 400, description: 'HR documents and data room materials' },
      { name: '500 Intellectual Property', sortOrder: 500, description: 'IP documentation and patents' },
    ];

    const foldersToInsert = defaultFolders.map(folder => ({
      ...folder,
      dealId,
      parentId: null,
      isRestricted: false,
    }));

    const { data: folders, error } = await supabase
      .from('Folder')
      .insert(foldersToInsert)
      .select();

    if (error) throw error;

    res.status(201).json({ created: true, folders });
  } catch (error) {
    next(error);
  }
});

export default router;

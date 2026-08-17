import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

const router = Router();

// ============================================================
// Section Validation Schemas
// ============================================================

const createSectionSchema = z.object({
  type: z.enum([
    'EXECUTIVE_SUMMARY',
    'COMPANY_OVERVIEW',
    'FINANCIAL_PERFORMANCE',
    'QUALITY_OF_EARNINGS',
    'MARKET_DYNAMICS',
    'COMPETITIVE_LANDSCAPE',
    'MANAGEMENT_ASSESSMENT',
    'OPERATIONAL_DEEP_DIVE',
    'RISK_ASSESSMENT',
    'DEAL_STRUCTURE',
    'VALUE_CREATION',
    'VALUE_CREATION_PLAN',
    'EXIT_STRATEGY',
    'EXIT_ANALYSIS',
    'RECOMMENDATION',
    'APPENDIX',
    'CUSTOM'
  ]),
  title: z.string().min(1),
  content: z.string().optional(),
  aiGenerated: z.boolean().optional().default(false),
  sortOrder: z.number().optional(),
  citations: z.array(z.any()).optional(),
  tableData: z.any().optional(),
  chartConfig: z.any().optional(),
});

const updateSectionSchema = createSectionSchema.partial();

const reorderSectionsSchema = z.object({
  sections: z.array(z.object({
    id: z.string().uuid(),
    sortOrder: z.number(),
  })),
});

// ============================================================
// Section Routes
// ============================================================

// GET /api/memos/:id/sections - Get all sections for a memo
router.get('/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    const { data: sections, error } = await supabase
      .from('MemoSection')
      .select('*')
      .eq('memoId', id)
      .order('sortOrder', { ascending: true });

    if (error) throw error;

    res.json(sections || []);
  } catch (error) {
    log.error('Error fetching sections', error);
    res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

// POST /api/memos/:id/sections - Add section
router.post('/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    const validation = createSectionSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // Get max sortOrder
    const { data: existingSections } = await supabase
      .from('MemoSection')
      .select('sortOrder')
      .eq('memoId', id)
      .order('sortOrder', { ascending: false })
      .limit(1);

    const maxSortOrder = existingSections?.[0]?.sortOrder ?? -1;

    const sectionData = {
      ...validation.data,
      memoId: id,
      sortOrder: validation.data.sortOrder ?? maxSortOrder + 1,
    };

    const { data: section, error } = await supabase
      .from('MemoSection')
      .insert(sectionData)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(section);
  } catch (error) {
    log.error('Error creating section', error);
    res.status(500).json({ error: 'Failed to create section' });
  }
});

// PATCH /api/memos/:id/sections/:sectionId - Update section
router.patch('/:id/sections/:sectionId', async (req, res) => {
  try {
    const { id, sectionId } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    const validation = updateSectionSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // F-7: bind sectionId to memo. Without this, a caller could supply their
    // own valid memoId (passes the org gate above) plus a sectionId from any
    // other org's memo and overwrite that section. Pre-check yields a real
    // 404 instead of a silent zero-row update.
    const { data: existing } = await supabase
      .from('MemoSection')
      .select('id')
      .eq('id', sectionId)
      .eq('memoId', id)
      .single();
    if (!existing) return res.status(404).json({ error: 'Section not found' });

    const { data: section, error } = await supabase
      .from('MemoSection')
      .update(validation.data)
      .eq('id', sectionId)
      .eq('memoId', id)
      .select()
      .single();

    if (error) throw error;

    res.json(section);
  } catch (error) {
    log.error('Error updating section', error);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// DELETE /api/memos/:id/sections/:sectionId - Delete section
router.delete('/:id/sections/:sectionId', async (req, res) => {
  try {
    const { id, sectionId } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    // F-8: bind sectionId to memo. Without this, a caller could delete a
    // section from any other org's memo. Pre-check yields a real 404 instead
    // of a silent zero-row delete.
    const { data: existing } = await supabase
      .from('MemoSection')
      .select('id')
      .eq('id', sectionId)
      .eq('memoId', id)
      .single();
    if (!existing) return res.status(404).json({ error: 'Section not found' });

    const { error } = await supabase
      .from('MemoSection')
      .delete()
      .eq('id', sectionId)
      .eq('memoId', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    log.error('Error deleting section', error);
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

// POST /api/memos/:id/sections/reorder - Reorder sections
router.post('/:id/sections/reorder', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify memo belongs to org
    const { data: memo } = await supabase.from('Memo').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    const validation = reorderSectionsSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // F-9: bind each sectionId to this memo. Without this, a caller could
    // scramble the sort order of any memo's sections by passing arbitrary
    // section IDs. Both the explicit memoId filter on each update AND the
    // pre-fetched ID intersection give defense in depth — the intersect
    // turns cross-memo IDs into a no-op rather than a row miss inside a
    // Promise.all swarm.
    const { data: validSections } = await supabase
      .from('MemoSection')
      .select('id')
      .eq('memoId', id);
    const validIds = new Set((validSections || []).map((s: any) => s.id));

    // Update each section's sortOrder
    const updates = validation.data.sections
      .filter(({ id: sectionId }) => validIds.has(sectionId))
      .map(({ id: sectionId, sortOrder }) =>
        supabase
          .from('MemoSection')
          .update({ sortOrder })
          .eq('id', sectionId)
          .eq('memoId', id)
      );

    await Promise.all(updates);

    // Fetch updated sections
    const { data: sections } = await supabase
      .from('MemoSection')
      .select('*')
      .eq('memoId', id)
      .order('sortOrder', { ascending: true });

    res.json(sections);
  } catch (error) {
    log.error('Error reordering sections', error);
    res.status(500).json({ error: 'Failed to reorder sections' });
  }
});

// POST /api/memos/:id/sections/:sectionId/apply - Apply a confirmed chat action
const applySectionSchema = z.object({
  content: z.string().optional(),
  tableData: z.any().optional(),
  chartConfig: z.any().optional(),
  insertPosition: z.enum(['append', 'prepend', 'replace']).optional().default('replace'),
});

router.post('/:id/sections/:sectionId/apply', async (req, res) => {
  try {
    const { id: memoId, sectionId } = req.params;
    const orgId = getOrgId(req);
    const { content, tableData, chartConfig, insertPosition } = applySectionSchema.parse(req.body);

    // Verify memo ownership
    const { data: memo } = await supabase
      .from('Memo')
      .select('id')
      .eq('id', memoId)
      .eq('organizationId', orgId)
      .single();

    if (!memo) return res.status(404).json({ error: 'Memo not found' });

    // Get current section (for undo data)
    const { data: section } = await supabase
      .from('MemoSection')
      .select('id, content, tableData, chartConfig')
      .eq('id', sectionId)
      .eq('memoId', memoId)
      .single();

    if (!section) return res.status(404).json({ error: 'Section not found' });

    // Build update
    const updateData: any = { updatedAt: new Date().toISOString() };

    if (content) {
      if (insertPosition === 'append') {
        updateData.content = (section.content || '') + '\n' + content;
      } else if (insertPosition === 'prepend') {
        updateData.content = content + '\n' + (section.content || '');
      } else {
        updateData.content = content;
      }
    }
    if (tableData !== undefined) updateData.tableData = tableData;
    if (chartConfig !== undefined) updateData.chartConfig = chartConfig;

    const { data: updated, error } = await supabase
      .from('MemoSection')
      .update(updateData)
      .eq('id', sectionId)
      .select('id, type, title, content, tableData, chartConfig, sortOrder')
      .single();

    if (error) throw error;

    // Return updated section + previous state for undo
    res.json({
      section: updated,
      previousContent: section.content,
      previousTableData: section.tableData,
      previousChartConfig: section.chartConfig,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    log.error('Apply section error', error);
    res.status(500).json({ error: 'Failed to apply section update' });
  }
});

export default router;

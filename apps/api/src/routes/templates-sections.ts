import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';

const router = Router();

// ============================================================
// Validation Schemas
// ============================================================

const createSectionSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  aiEnabled: z.boolean().optional().default(false),
  aiPrompt: z.string().optional(),
  mandatory: z.boolean().optional().default(false),
  requiresApproval: z.boolean().optional().default(false),
  sortOrder: z.number().optional(),
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

// GET /api/templates/:id/sections - Get all sections for a template
router.get('/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify template belongs to org
    const { data: tpl } = await supabase.from('MemoTemplate').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const { data: sections, error } = await supabase
      .from('MemoTemplateSection')
      .select('*')
      .eq('templateId', id)
      .order('sortOrder', { ascending: true });

    if (error) throw error;

    res.json(sections || []);
  } catch (error) {
    log.error('Error fetching template sections', error);
    res.status(500).json({ error: 'Failed to fetch sections' });
  }
});

// POST /api/templates/:id/sections - Add section to template
router.post('/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify template belongs to org
    const { data: tpl } = await supabase.from('MemoTemplate').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const validation = createSectionSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // Get max sortOrder
    const { data: existingSections } = await supabase
      .from('MemoTemplateSection')
      .select('sortOrder')
      .eq('templateId', id)
      .order('sortOrder', { ascending: false })
      .limit(1);

    const maxSortOrder = existingSections?.[0]?.sortOrder ?? -1;

    const sectionData = {
      ...validation.data,
      templateId: id,
      sortOrder: validation.data.sortOrder ?? maxSortOrder + 1,
    };

    const { data: section, error } = await supabase
      .from('MemoTemplateSection')
      .insert(sectionData)
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(section);
  } catch (error) {
    log.error('Error creating template section', error);
    res.status(500).json({ error: 'Failed to create section' });
  }
});

// PATCH /api/templates/:id/sections/:sectionId - Update section
router.patch('/:id/sections/:sectionId', async (req, res) => {
  try {
    const { id, sectionId } = req.params;
    const orgId = getOrgId(req);

    // Verify template belongs to org
    const { data: tpl } = await supabase.from('MemoTemplate').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const validation = updateSectionSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // F-11: bind sectionId to template. Without this, a caller could pass
    // their own templateId (passes org gate) plus another firm's sectionId
    // and overwrite that section — e.g. inject a malicious aiPrompt that
    // runs the next time the target firm regenerates the template.
    const { data: existing } = await supabase
      .from('MemoTemplateSection')
      .select('id')
      .eq('id', sectionId)
      .eq('templateId', id)
      .single();
    if (!existing) return res.status(404).json({ error: 'Section not found' });

    const { data: section, error } = await supabase
      .from('MemoTemplateSection')
      .update(validation.data)
      .eq('id', sectionId)
      .eq('templateId', id)
      .select()
      .single();

    if (error) throw error;

    res.json(section);
  } catch (error) {
    log.error('Error updating template section', error);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// DELETE /api/templates/:id/sections/:sectionId - Delete section
router.delete('/:id/sections/:sectionId', async (req, res) => {
  try {
    const { id, sectionId } = req.params;
    const orgId = getOrgId(req);

    // Verify template belongs to org
    const { data: tpl } = await supabase.from('MemoTemplate').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    // F-12: bind sectionId to template. Without this, a caller could delete
    // a section from any other org's template.
    const { data: existing } = await supabase
      .from('MemoTemplateSection')
      .select('id')
      .eq('id', sectionId)
      .eq('templateId', id)
      .single();
    if (!existing) return res.status(404).json({ error: 'Section not found' });

    const { error } = await supabase
      .from('MemoTemplateSection')
      .delete()
      .eq('id', sectionId)
      .eq('templateId', id);

    if (error) throw error;

    res.json({ success: true });
  } catch (error) {
    log.error('Error deleting template section', error);
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

// POST /api/templates/:id/sections/reorder - Reorder sections
router.post('/:id/sections/reorder', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Verify template belongs to org
    const { data: tpl } = await supabase.from('MemoTemplate').select('id').eq('id', id).eq('organizationId', orgId).single();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const validation = reorderSectionsSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // Update each section's sortOrder
    const updates = validation.data.sections.map(({ id: sectionId, sortOrder }) =>
      supabase
        .from('MemoTemplateSection')
        .update({ sortOrder })
        .eq('id', sectionId)
    );

    await Promise.all(updates);

    // Fetch updated sections
    const { data: sections } = await supabase
      .from('MemoTemplateSection')
      .select('*')
      .eq('templateId', id)
      .order('sortOrder', { ascending: true });

    res.json(sections);
  } catch (error) {
    log.error('Error reordering template sections', error);
    res.status(500).json({ error: 'Failed to reorder sections' });
  }
});

export default router;

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { z } from 'zod';
import { requirePermission, PERMISSIONS } from '../middleware/rbac.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import templateSectionsRouter from './templates-sections.js';

const router = Router();

// Mount section sub-router
router.use('/', templateSectionsRouter);

// ============================================================
// Validation Schemas
// ============================================================

const createTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.enum(['INVESTMENT_MEMO', 'CHECKLIST', 'OUTREACH']).default('INVESTMENT_MEMO'),
  isGoldStandard: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  permissions: z.enum(['FIRM_WIDE', 'PARTNERS_ONLY', 'ANALYSTS_ONLY']).optional().default('FIRM_WIDE'),
});

const updateTemplateSchema = createTemplateSchema.partial();

const templatesQuerySchema = z.object({
  category: z.enum(['INVESTMENT_MEMO', 'CHECKLIST', 'OUTREACH']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const duplicateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

// ============================================================
// Template CRUD Routes
// ============================================================

// GET /api/templates - List all templates
router.get('/', async (req, res) => {
  try {
    const params = templatesQuerySchema.parse(req.query);
    const orgId = getOrgId(req);

    let query = supabase
      .from('MemoTemplate')
      .select(`
        *,
        sections:MemoTemplateSection(id, title, description, aiEnabled, mandatory, sortOrder),
        createdByUser:User!MemoTemplate_createdBy_fkey(name, email)
      `)
      .eq('organizationId', orgId)
      .order('usageCount', { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);

    // Apply filters
    if (params.category) query = query.eq('category', params.category);
    if (params.isActive !== undefined) query = query.eq('isActive', params.isActive === 'true');

    const { data: templates, error } = await query;

    if (error) {
      // If template tables/relations are missing, return empty list so UI can fall back gracefully.
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.json([]);
      }
      throw error;
    }

    // Sort sections by sortOrder
    templates?.forEach((template: any) => {
      if (template.sections) {
        template.sections.sort((a: any, b: any) => a.sortOrder - b.sortOrder);
      }
    });

    res.json(templates || []);
  } catch (error) {
    log.error('Error fetching templates', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// GET /api/templates/:id - Get single template with all sections
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    const { data: template, error } = await supabase
      .from('MemoTemplate')
      .select(`
        *,
        sections:MemoTemplateSection(*),
        createdByUser:User!MemoTemplate_createdBy_fkey(name, email)
      `)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Template not found' });
      }
      throw error;
    }

    // Sort sections by sortOrder
    if (template.sections) {
      template.sections.sort((a: any, b: any) => a.sortOrder - b.sortOrder);
    }

    res.json(template);
  } catch (error) {
    log.error('Error fetching template', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// POST /api/templates - Create new template
router.post('/', async (req, res) => {
  try {
    const user = req.user;
    const validation = createTemplateSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    const orgId = getOrgId(req);
    const templateData = {
      ...validation.data,
      createdBy: user?.id,
      usageCount: 0,
      organizationId: orgId,
    };

    const { data: template, error } = await supabase
      .from('MemoTemplate')
      .insert(templateData)
      .select()
      .single();

    if (error) throw error;

    // Create default section
    const defaultSection = {
      templateId: template.id,
      title: 'Executive Summary',
      description: 'High-level overview of the investment opportunity.',
      aiEnabled: true,
      mandatory: true,
      sortOrder: 0,
    };

    await supabase.from('MemoTemplateSection').insert(defaultSection);

    // Fetch the template with sections
    const { data: fullTemplate } = await supabase
      .from('MemoTemplate')
      .select(`*, sections:MemoTemplateSection(*)`)
      .eq('id', template.id)
      .single();

    // Audit log
    await AuditLog.log(req, {
      action: 'TEMPLATE_CREATED',
      resourceType: 'MemoTemplate',
      resourceId: template.id,
      metadata: { name: template.name },
    });

    res.status(201).json(fullTemplate);
  } catch (error) {
    log.error('Error creating template', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PATCH /api/templates/:id - Update template
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);
    const validation = updateTemplateSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    const updateData = {
      ...validation.data,
      updatedAt: new Date().toISOString(),
    };

    const { data: template, error } = await supabase
      .from('MemoTemplate')
      .update(updateData)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (error) throw error;

    res.json(template);
  } catch (error) {
    log.error('Error updating template', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/templates/:id - Delete template
router.delete('/:id', requirePermission(PERMISSIONS.MEMO_DELETE), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Get template name before deleting for audit log
    const { data: template } = await supabase
      .from('MemoTemplate')
      .select('name')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    const { error } = await supabase
      .from('MemoTemplate')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    // Audit log
    await AuditLog.log(req, {
      action: 'TEMPLATE_DELETED',
      resourceType: 'MemoTemplate',
      resourceId: id,
      metadata: { name: template?.name },
    });

    res.json({ success: true });
  } catch (error) {
    log.error('Error deleting template', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /api/templates/:id/duplicate - Duplicate a template
router.post('/:id/duplicate', async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const orgId = getOrgId(req);
    const { name } = duplicateTemplateSchema.parse(req.body);

    // Get original template with sections (org-scoped)
    const { data: original, error: fetchError } = await supabase
      .from('MemoTemplate')
      .select(`*, sections:MemoTemplateSection(*)`)
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (fetchError) throw fetchError;

    // Create new template
    const { data: newTemplate, error: createError } = await supabase
      .from('MemoTemplate')
      .insert({
        name: name || `${original.name} (Copy)`,
        description: original.description,
        category: original.category,
        isGoldStandard: false,
        isActive: true,
        permissions: original.permissions,
        createdBy: user?.id,
        usageCount: 0,
        organizationId: orgId,
      })
      .select()
      .single();

    if (createError) throw createError;

    // Duplicate sections
    if (original.sections?.length > 0) {
      const newSections = original.sections.map((section: any) => ({
        templateId: newTemplate.id,
        title: section.title,
        description: section.description,
        aiEnabled: section.aiEnabled,
        aiPrompt: section.aiPrompt,
        mandatory: section.mandatory,
        requiresApproval: section.requiresApproval,
        sortOrder: section.sortOrder,
      }));

      await supabase.from('MemoTemplateSection').insert(newSections);
    }

    // Fetch complete new template
    const { data: fullTemplate } = await supabase
      .from('MemoTemplate')
      .select(`*, sections:MemoTemplateSection(*)`)
      .eq('id', newTemplate.id)
      .single();

    res.status(201).json(fullTemplate);
  } catch (error) {
    log.error('Error duplicating template', error);
    res.status(500).json({ error: 'Failed to duplicate template' });
  }
});

// POST /api/templates/:id/use - Use template (increment usage count)
router.post('/:id/use', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // F-19: verify the template belongs to the caller's org BEFORE the RPC.
    // The `increment_template_usage` RPC takes only template_id and would
    // bump usageCount on any org's template otherwise. Mirror the
    // memos-mutate fix here.
    const { data: existing } = await supabase
      .from('MemoTemplate')
      .select('id')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Increment usage count
    const { error } = await supabase
      .rpc('increment_template_usage', { template_id: id });

    // Fallback if RPC doesn't exist
    if (error) {
      const { data: current } = await supabase
        .from('MemoTemplate')
        .select('usageCount')
        .eq('id', id)
        .eq('organizationId', orgId)
        .single();

      await supabase
        .from('MemoTemplate')
        .update({ usageCount: (current?.usageCount || 0) + 1 })
        .eq('id', id)
        .eq('organizationId', orgId);
    }

    res.json({ success: true });
  } catch (error) {
    log.error('Error incrementing template usage', error);
    res.status(500).json({ error: 'Failed to update template usage' });
  }
});

export default router;

// ─── Memo create / update / delete routes ─────────────────────────
// POST   /api/memos       — create memo (with template + auto-generate)
// PATCH  /api/memos/:id   — update memo metadata
// DELETE /api/memos/:id   — delete memo (requires MEMO_DELETE)

import { Router } from 'express';
import { supabase } from '../supabase.js';
import { requirePermission, PERMISSIONS } from '../middleware/rbac.js';
import { AuditLog } from '../services/auditLog.js';
import { log } from '../utils/logger.js';
import { getOrgId } from '../middleware/orgScope.js';
import {
  generateAllSections,
  COMPREHENSIVE_IC_SECTIONS,
  STANDARD_IC_SECTIONS,
  SEARCH_FUND_SECTIONS,
  SCREENING_NOTE_SECTIONS,
} from '../services/agents/memoAgent/index.js';
import { isLLMAvailable } from '../services/llm.js';
import { createMemoSchema, updateMemoSchema, SECTION_TYPE_MAP } from './memos-schemas.js';

const router = Router();

// POST /api/memos - Create new memo
router.post('/', async (req, res) => {
  try {
    const user = req.user;
    const orgId = getOrgId(req);
    log.debug('Memo create started', { userId: user?.id });

    const validation = createMemoSchema.safeParse(req.body);

    if (!validation.success) {
      log.debug('Memo validation failed', { errors: validation.error.errors });
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    // Strip templateId, autoGenerate, templatePreset from memoData (not Memo table columns)
    const { templateId, autoGenerate, templatePreset, ...memoFields } = validation.data;

    // Fetch deal name if dealId provided and no explicit project name
    if (memoFields.dealId && (!memoFields.projectName || memoFields.projectName === 'New Project')) {
      const { data: deal } = await supabase
        .from('Deal')
        .select('name')
        .eq('id', memoFields.dealId)
        .single();
      if (deal?.name) {
        memoFields.projectName = deal.name;
      }
    }

    const memoData = {
      ...memoFields,
      createdBy: user?.id,
      lastEditedBy: user?.id,
      organizationId: orgId,
    };

    const { data: memo, error } = await supabase
      .from('Memo')
      .insert(memoData)
      .select()
      .single();

    if (error) {
      throw error;
    }
    log.debug('Memo created', { memoId: memo.id, templateId });

    // Create sections from template or use defaults
    let usedTemplate = false;
    if (templateId) {
      const { data: templateSections, error: tplError } = await supabase
        .from('MemoTemplateSection')
        .select('*')
        .eq('templateId', templateId)
        .order('sortOrder', { ascending: true });

      if (!tplError && templateSections && templateSections.length > 0) {
        const sections = templateSections.map((ts: any, idx: number) => ({
          memoId: memo.id,
          type: SECTION_TYPE_MAP[ts.title.toLowerCase()] || 'CUSTOM',
          title: ts.title,
          sortOrder: ts.sortOrder ?? idx,
          aiPrompt: ts.aiPrompt || null,
        }));

        const { error: sectionsError } = await supabase.from('MemoSection').insert(sections);
        if (sectionsError) throw sectionsError;

        usedTemplate = true;

        // Increment template usage count
        const { data: tpl } = await supabase
          .from('MemoTemplate')
          .select('usageCount')
          .eq('id', templateId)
          .single();
        if (tpl) {
          await supabase
            .from('MemoTemplate')
            .update({ usageCount: (tpl.usageCount || 0) + 1 })
            .eq('id', templateId);
        }

        log.debug('Memo created from template', { memoId: memo.id, templateId, sectionCount: sections.length });
      }
    }

    // Fall back to default sections for IC_MEMO if no template was used
    if (!usedTemplate && memo.type === 'IC_MEMO') {
      const defaultSections = [
        { memoId: memo.id, type: 'EXECUTIVE_SUMMARY', title: 'Executive Summary', sortOrder: 0 },
        { memoId: memo.id, type: 'FINANCIAL_PERFORMANCE', title: 'Financial Performance', sortOrder: 1 },
        { memoId: memo.id, type: 'MARKET_DYNAMICS', title: 'Market Dynamics', sortOrder: 2 },
        { memoId: memo.id, type: 'RISK_ASSESSMENT', title: 'Risk Assessment', sortOrder: 3 },
        { memoId: memo.id, type: 'DEAL_STRUCTURE', title: 'Deal Structure', sortOrder: 4 },
      ];

      const { error: sectionsError } = await supabase.from('MemoSection').insert(defaultSections);
      if (sectionsError) throw sectionsError;
    }

    // Auto-generate section content if requested and AI is available
    let generationStatus = null;

    if (autoGenerate && memoFields.dealId && isLLMAvailable()) {
      try {
        const presetMap: Record<string, any> = {
          comprehensive: COMPREHENSIVE_IC_SECTIONS,
          standard: STANDARD_IC_SECTIONS,
          search_fund: SEARCH_FUND_SECTIONS,
          screening: SCREENING_NOTE_SECTIONS,
        };
        const sectionTypes = templatePreset ? presetMap[templatePreset] : undefined;
        const { sections: generated } = await generateAllSections(memoFields.dealId, orgId, sectionTypes);

        // Pre-fetch ALL existing sections for this memo in ONE query. The prior
        // code did a per-section `.single()` existence check inside a for-loop,
        // turning a 10-section generation into 10-20 sequential round-trips.
        // No compound unique on (memoId, type) exists in the schema (multiple
        // CUSTOM sections coexist), so we classify in-memory then issue parallel
        // updates by primary key — the N+1 existence-check selects are gone.
        const { data: existingRows } = await supabase
          .from('MemoSection')
          .select('id, type')
          .eq('memoId', memo.id);
        const existingByType = new Map<string, { id: string }>();
        for (const row of existingRows || []) {
          // First match wins; multiple CUSTOM rows are intentionally not matched
          // (the original code's .single() would have errored on duplicates too).
          if (!existingByType.has(row.type)) existingByType.set(row.type, { id: row.id });
        }

        let completed = 0;
        const errors: string[] = [];
        const updatePromises: Promise<any>[] = [];
        for (const gen of generated) {
          const existingSection = existingByType.get(gen.type);
          if (existingSection) {
            const updateData: any = {
              content: gen.content,
              aiGenerated: gen.aiGenerated,
              aiModel: gen.aiModel,
              updatedAt: new Date().toISOString(),
            };
            if (gen.tableData) updateData.tableData = gen.tableData;
            if (gen.chartConfig) updateData.chartConfig = gen.chartConfig;
            updatePromises.push(
              supabase.from('MemoSection').update(updateData).eq('id', existingSection.id)
            );
            completed++;
          }
        }
        await Promise.all(updatePromises);
        generationStatus = { completed, total: generated.length, errors };
      } catch (error: any) {
        log.error('Auto-generation failed', { memoId: memo.id, error: error.message });
        generationStatus = { completed: 0, total: 0, errors: [error.message] };
      }
    }

    // Fetch the memo with sections
    const { data: fullMemo, error: fetchError } = await supabase
      .from('Memo')
      .select(`*, sections:MemoSection(*)`)
      .eq('id', memo.id)
      .single();

    if (fetchError) {
      throw fetchError;
    }

    // Audit log
    await AuditLog.memoCreated(req, memo.id, memo.title);
    log.debug('Memo created successfully', { memoId: memo.id });

    res.status(201).json({
      ...fullMemo,
      ...(generationStatus && { generationStatus }),
    });
  } catch (error: any) {
    log.error('Error creating memo', error);
    // Return detailed error in development for debugging
    const errorMessage = error?.message || 'Unknown error';
    const errorDetails = {
      message: errorMessage,
      code: error?.code,
      details: error?.details,
      hint: error?.hint,
    };
    log.error('Memo create error', undefined, errorDetails);
    res.status(500).json({
      error: `Failed to create memo: ${errorMessage}`,
      debug: errorDetails
    });
  }
});

// PATCH /api/memos/:id - Update memo
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const orgId = getOrgId(req);
    const validation = updateMemoSchema.safeParse(req.body);

    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid data', details: validation.error.errors });
    }

    const updateData = {
      ...validation.data,
      lastEditedBy: user?.id,
      updatedAt: new Date().toISOString(),
    };

    const { data: memo, error } = await supabase
      .from('Memo')
      .update(updateData)
      .eq('id', id)
      .eq('organizationId', orgId)
      .select()
      .single();

    if (error) throw error;

    res.json(memo);
  } catch (error) {
    log.error('Error updating memo', error);
    res.status(500).json({ error: 'Failed to update memo' });
  }
});

// DELETE /api/memos/:id - Delete memo (requires MEMO_DELETE permission)
router.delete('/:id', requirePermission(PERMISSIONS.MEMO_DELETE), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = getOrgId(req);

    // Get memo title before deleting for audit log
    const { data: memo } = await supabase
      .from('Memo')
      .select('title')
      .eq('id', id)
      .eq('organizationId', orgId)
      .single();

    const { error } = await supabase
      .from('Memo')
      .delete()
      .eq('id', id)
      .eq('organizationId', orgId);

    if (error) throw error;

    // Audit log
    await AuditLog.memoDeleted(req, id, memo?.title || 'Untitled');

    res.json({ success: true });
  } catch (error) {
    log.error('Error deleting memo', error);
    res.status(500).json({ error: 'Failed to delete memo' });
  }
});

export default router;

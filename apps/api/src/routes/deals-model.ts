// ─── Deal model ───────────────────────────────────────────────────
// GET  /api/deals/:dealId/model        — saved assumptions, or derived
// PUT  /api/deals/:dealId/model        — save assumptions
// POST /api/deals/:dealId/model/export — the .xlsx binary
//
// Demo-call origin: Evan M15, Himanshu M11, Daniel Callahan — the actual
// deliverable a deal team sends its IC and its lender is a spreadsheet,
// and until now the extraction's value was thrown away at that last step.
//
// No LLM call anywhere in here, so pickBundle leaves these paths in the
// LITE bundle. Mount accordingly.
//
// Backed by DealModel — see apps/api/deal-model-migration.sql (applied
// MANUALLY per the repo's Supabase-migrations convention).

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../supabase.js';
import { getOrgId, verifyDealAccess } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import {
  normaliseStatements,
  deriveDefaults,
  assumptionsSchema,
  UnitMismatchError,
  type ModelAssumptions,
  type HistoricalRow,
} from '../services/dealModel/assumptions.js';
import { buildModelWorkbook } from '../services/dealModel/workbook.js';

const router = Router();

const DEFAULT_CASE = 'Base case';

/**
 * Cross-field rules the plain schema can't express. Both of these would
 * otherwise produce a workbook that references an assumption cell which
 * doesn't exist — a silent #REF! rather than a clear 400.
 */
const coherentAssumptions = assumptionsSchema
  .refine((a) => a.revenueGrowthPct.length === a.projectionYears, {
    message: 'revenueGrowthPct must have exactly one entry per projected year',
    path: ['revenueGrowthPct'],
  })
  .refine((a) => a.ebitdaMarginPct.length === a.projectionYears, {
    message: 'ebitdaMarginPct must have exactly one entry per projected year',
    path: ['ebitdaMarginPct'],
  })
  .refine((a) => a.exitYear <= a.projectionYears, {
    message: 'exitYear cannot be beyond the projection window',
    path: ['exitYear'],
  });

interface LoadedDeal {
  deal: { id: string; name: string; companyName: string | null; currency: string | null; evMultiple: number | null };
  history: HistoricalRow[];
  currency: string;
  documentNames: string[];
}

/** Load + normalise everything the model needs. Throws UnitMismatchError. */
async function loadModelInputs(dealId: string, orgId: string): Promise<LoadedDeal | null> {
  const { data: deal } = await supabase
    .from('Deal')
    .select('id, name, companyName, currency, evMultiple')
    .eq('id', dealId)
    .eq('organizationId', orgId)
    .single();
  if (!deal) return null;

  const { data: statements } = await supabase
    .from('FinancialStatement')
    .select('statementType, period, periodType, currency, unitScale, isActive, lineItems')
    .eq('dealId', dealId)
    .eq('isActive', true)
    .order('period', { ascending: true });

  const { rows, currency } = normaliseStatements(statements ?? []);

  const { data: docs } = await supabase
    .from('Document')
    .select('name')
    .eq('dealId', dealId)
    .in('type', ['CIM', 'FINANCIALS'])
    .limit(10);

  return {
    deal: deal as LoadedDeal['deal'],
    history: rows,
    currency,
    documentNames: (docs ?? []).map((d: { name: string }) => d.name),
  };
}

async function loadSavedAssumptions(dealId: string, orgId: string): Promise<ModelAssumptions | null> {
  const { data } = await supabase
    .from('DealModel')
    .select('assumptions')
    .eq('dealId', dealId)
    .eq('organizationId', orgId)
    .eq('name', DEFAULT_CASE)
    .single();
  return (data?.assumptions as ModelAssumptions) ?? null;
}

function sendModelError(res: Parameters<typeof router.get>[1] extends never ? never : any, error: unknown) {
  if (error instanceof UnitMismatchError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  const message = error instanceof Error ? error.message : String(error);
  log.error('Deal model failed', { error: message });
  return res.status(500).json({ error: 'Failed to build the model' });
}

// GET /api/deals/:dealId/model
router.get('/:dealId/model', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const access = await verifyDealAccess(dealId, orgId);
    if (!access) return res.status(404).json({ error: 'Deal not found' });

    const inputs = await loadModelInputs(dealId, orgId);
    if (!inputs) return res.status(404).json({ error: 'Deal not found' });

    const saved = await loadSavedAssumptions(dealId, orgId);
    const assumptions = saved ?? deriveDefaults(inputs.history, {
      evMultiple: inputs.deal.evMultiple,
      currency: inputs.currency,
    });

    res.json({
      assumptions,
      isDerived: !saved,
      history: inputs.history,
      currency: inputs.currency,
      unitScale: 'MILLIONS',
      sourceDocuments: inputs.documentNames,
    });
  } catch (error) {
    sendModelError(res, error);
  }
});

// PUT /api/deals/:dealId/model
router.put('/:dealId/model', async (req, res) => {
  const parsed = coherentAssumptions.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid assumptions', details: parsed.error.flatten() });
  }
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const access = await verifyDealAccess(dealId, orgId);
    if (!access) return res.status(404).json({ error: 'Deal not found' });

    const { data, error } = await supabase
      .from('DealModel')
      .upsert(
        {
          dealId,
          organizationId: orgId,
          name: DEFAULT_CASE,
          assumptions: parsed.data,
          createdBy: (req as any).user?.id ?? null,
          updatedAt: new Date().toISOString(),
        },
        { onConflict: 'dealId,name' },
      )
      .select()
      .single();
    if (error) throw error;

    res.json({ success: true, model: data });
  } catch (error) {
    sendModelError(res, error);
  }
});

// POST /api/deals/:dealId/model/export — returns the workbook
router.post('/:dealId/model/export', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const access = await verifyDealAccess(dealId, orgId);
    if (!access) return res.status(404).json({ error: 'Deal not found' });

    const inputs = await loadModelInputs(dealId, orgId);
    if (!inputs) return res.status(404).json({ error: 'Deal not found' });

    // An empty workbook is worse than an error — it looks like a product
    // failure rather than a missing prerequisite the user can act on.
    if (inputs.history.length === 0) {
      return res.status(400).json({
        error: 'Extract financials for this deal before building a model.',
        code: 'NO_FINANCIALS',
      });
    }

    const saved = await loadSavedAssumptions(dealId, orgId);
    const base = saved ?? deriveDefaults(inputs.history, {
      evMultiple: inputs.deal.evMultiple,
      currency: inputs.currency,
    });

    // Body may carry unsaved edits from the panel — merge over the base so
    // "download" always reflects what the user is looking at.
    const merged = coherentAssumptions.safeParse({ ...base, ...(req.body ?? {}) });
    const assumptions = merged.success ? merged.data : base;

    const buffer = await buildModelWorkbook({
      assumptions,
      history: inputs.history,
      context: {
        dealName: inputs.deal.name,
        companyName: inputs.deal.companyName,
        currency: inputs.currency,
        unitScale: 'MILLIONS',
        sourceDocuments: inputs.documentNames,
        generatedAt: new Date().toISOString(),
        notes: inputs.history.length < 2
          ? ['Only one historical period was available — growth assumptions are defaults, not derived.']
          : [],
      },
    });

    const safeName = (inputs.deal.companyName || inputs.deal.name)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'deal';

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-model.xlsx"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.status(200).send(buffer);
  } catch (error) {
    sendModelError(res, error);
  }
});

export default router;

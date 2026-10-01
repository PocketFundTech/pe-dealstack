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
  resolveAssumptions,
  assumptionsSchema,
  UnitMismatchError,
  type ModelAssumptions,
  type HistoricalRow,
} from '../services/dealModel/assumptions.js';
import { buildModelWorkbook } from '../services/dealModel/workbook.js';
import { selectBasePeriod } from '../services/dealModel/basePeriod.js';
import { buildLineCatalogue, baseColumnValues, evaluateLine } from '../services/dealModel/lineCatalogue.js';

const router = Router();

const DEFAULT_CASE = 'Base case';

/**
 * Deal has NO `companyName` column (company is a relation via
 * Deal.companyId) and NO `evMultiple` column at all. Selecting either
 * errors the whole PostgREST query and returns null data, which this route
 * would read as "deal not found" — a 404 on every model request. Same
 * defect class as the portal bug fixed in #118.
 */
function extractCompanyName(company: unknown): string | null {
  const c = Array.isArray(company) ? company[0] : company;
  if (c && typeof c === 'object' && 'name' in c) {
    const name = (c as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

/** Implied entry multiple = EV / EBITDA, from the columns Deal really has. */
function impliedEvMultiple(dealSize: unknown, ebitda: unknown): number | null {
  if (typeof dealSize !== 'number' || typeof ebitda !== 'number') return null;
  if (!Number.isFinite(dealSize) || !Number.isFinite(ebitda) || ebitda <= 0) return null;
  const multiple = dealSize / ebitda;
  return Number.isFinite(multiple) && multiple > 0 ? Math.round(multiple * 100) / 100 : null;
}

/**
 * Deal.ebitda is stored in millions (AGENTS.md), but hand-entered deals
 * sometimes hold whole dollars — anything above 100,000 "millions" is
 * clearly that, so convert rather than seed a trillion-dollar entry EV.
 */
function dealEbitdaMillions(ebitda: unknown): number | null {
  if (typeof ebitda !== 'number' || !Number.isFinite(ebitda) || ebitda <= 0) return null;
  return ebitda > 100_000 ? ebitda / 1_000_000 : ebitda;
}

/**
 * Cross-field rules the plain schema can't express. Both of these would
 * otherwise produce a workbook that references an assumption cell which
 * doesn't exist — a silent #REF! rather than a clear 400.
 */
const coherentAssumptions = assumptionsSchema
  .refine((a) => !a.revenueGrowthPct || a.revenueGrowthPct.length === a.projectionYears, {
    message: 'revenueGrowthPct must have exactly one entry per projected year',
    path: ['revenueGrowthPct'],
  })
  .refine((a) => !a.ebitdaMarginPct || a.ebitdaMarginPct.length === a.projectionYears, {
    message: 'ebitdaMarginPct must have exactly one entry per projected year',
    path: ['ebitdaMarginPct'],
  })
  .refine((a) => Object.values(a.lineDrivers ?? {}).every((d) => d.method === 'SUBTOTAL' || d.values.length === a.projectionYears), {
    message: 'every line driver must have exactly one value per projected year',
    path: ['lineDrivers'],
  })
  .refine((a) => Object.values(a.lineDrivers ?? {}).every((d) => d.method === 'FIXED' || d.values.every((v) => v >= -100 && v <= 500)), {
    message: 'growth and % of revenue drivers must be between -100% and 500%',
    path: ['lineDrivers'],
  })
  .refine((a) => a.exitYear <= a.projectionYears, {
    message: 'exitYear cannot be beyond the projection window',
    path: ['exitYear'],
  });

interface LoadedDeal {
  deal: {
    id: string; name: string; companyName: string | null; currency: string | null; evMultiple: number | null;
    /** Deal.ebitda in millions — the model's entry-EBITDA fallback. */
    ebitdaMillions: number | null;
  };
  history: HistoricalRow[];
  currency: string;
  documentNames: string[];
}

/** Load + normalise everything the model needs. Throws UnitMismatchError. */
async function loadModelInputs(dealId: string, orgId: string): Promise<LoadedDeal | null> {
  const { data: deal } = await supabase
    .from('Deal')
    .select('id, name, currency, dealSize, ebitda, company:Company(name)')
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

  const row = deal as Record<string, unknown>;
  return {
    deal: {
      id: String(row.id),
      name: String(row.name),
      companyName: extractCompanyName(row.company),
      currency: (row.currency as string | null) ?? null,
      evMultiple: impliedEvMultiple(row.dealSize, row.ebitda),
      ebitdaMillions: dealEbitdaMillions(row.ebitda),
    },
    history: rows,
    currency,
    documentNames: (docs ?? []).map((d: { name: string }) => d.name),
  };
}

function dealSeed(inputs: LoadedDeal) {
  return { evMultiple: inputs.deal.evMultiple, currency: inputs.currency };
}

/**
 * The line catalogue and base column the workbook projects from (LTM or
 * last full year) — the panel's driver table and preview read these rather
 * than guessing from history.
 */
function modelStructure(inputs: LoadedDeal, catalogue: ReturnType<typeof buildLineCatalogue>) {
  const base = selectBasePeriod(inputs.history);
  const baseCol = baseColumnValues(catalogue, inputs.history, base, inputs.deal.ebitdaMillions);
  return {
    lines: catalogue.lines,
    baseValues: baseCol.values,
    base: base
      ? {
          label: base.label,
          basis: base.basis,
          revenue: evaluateLine(catalogue.lines, baseCol.values, 'revenue'),
          ebitda: baseCol.entrySource === 'missing' ? null : evaluateLine(catalogue.lines, baseCol.values, 'ebitda'),
          entrySource: baseCol.entrySource,
        }
      : null,
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

/**
 * Body may carry unsaved edits from the panel — merge over the saved set so
 * "download" always reflects what the user is looking at. An invalid body is
 * ignored rather than failing the download.
 */
function withEdits(
  base: ReturnType<typeof resolveAssumptions>, body: unknown, inputs: LoadedDeal,
  catalogue: ReturnType<typeof buildLineCatalogue>,
) {
  const edits = (body && typeof body === 'object' ? body : {}) as Partial<ModelAssumptions>;
  const merged: Partial<ModelAssumptions> = { ...base, ...edits };
  // A pre-E1 client posting growth / margin edits: migrate those, not the saved drivers.
  if (!edits.lineDrivers && (edits.revenueGrowthPct || edits.ebitdaMarginPct)) delete merged.lineDrivers;
  const parsed = coherentAssumptions.safeParse(merged);
  return parsed.success ? resolveAssumptions(parsed.data, inputs.history, dealSeed(inputs), catalogue) : base;
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
    const catalogue = buildLineCatalogue(inputs.history);
    const assumptions = resolveAssumptions(saved, inputs.history, dealSeed(inputs), catalogue);

    res.json({
      assumptions,
      isDerived: !saved,
      history: inputs.history,
      ...modelStructure(inputs, catalogue),
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
    const catalogue = buildLineCatalogue(inputs.history);
    const assumptions = withEdits(
      resolveAssumptions(saved, inputs.history, dealSeed(inputs), catalogue), req.body, inputs, catalogue,
    );

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
        fallbackEntryEbitda: inputs.deal.ebitdaMillions,
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

// ─── Deal model ───────────────────────────────────────────────────
// GET  /api/deals/:dealId/model?case=Low|Base|High — one case: saved, or derived (Base) / seeded from Base (Low, High)
// GET  /api/deals/:dealId/model/cases              — all three cases + a summary of each
//      (both GETs carry `opening`: the latest full-year balance sheet — fix plan E3)
// PUT  /api/deals/:dealId/model?case=…             — save one case
// POST /api/deals/:dealId/model/export?case=…      — the .xlsx binary (all three cases, opened on `case`)
//
// Cases are DealModel rows named "Low case" / "Base case" / "High case"
// (UNIQUE("dealId", name) already exists — no migration). `case` defaults
// to Base, which is the row every pre-E2 model was saved under.
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
import {
  CASE_ROW_NAMES, MODEL_CASES, SCENARIO_DELTAS, parseCase, resolveCases, type CaseSet, type ModelCase,
} from '../services/dealModel/scenarios.js';
import { activeBalanceKeys, summariseCase } from '@ai-crm/shared';
import { openingBalances } from '../services/dealModel/balanceItems.js';
import { entrySeed, type EntrySeed } from '../services/dealModel/entrySeed.js';

const router = Router();

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
  .refine((a) => !a.balanceDrivers || activeBalanceKeys(a.balanceDrivers).every((k) => a.balanceDrivers![k].length === a.projectionYears), {
    message: 'working-capital and capex drivers must have exactly one value per projected year',
    path: ['balanceDrivers'],
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

type Catalogue = ReturnType<typeof buildLineCatalogue>;

/** Base period + entry seed: everything the defaults and the panel read about entry. */
function entryContext(inputs: LoadedDeal, catalogue: Catalogue) {
  const base = selectBasePeriod(inputs.history);
  const baseCol = baseColumnValues(catalogue, inputs.history, base, inputs.deal.ebitdaMillions);
  const seed = entrySeed({
    impliedMultiple: inputs.deal.evMultiple,
    dealEbitda: inputs.deal.ebitdaMillions,
    statementsEbitda: baseCol.entrySource === 'base' ? evaluateLine(catalogue.lines, baseCol.values, 'ebitda') : null,
    entrySource: baseCol.entrySource,
  });
  return { base, baseCol, seed };
}

function dealSeed(inputs: LoadedDeal, seed: EntrySeed) {
  return { evMultiple: seed.evMultiple, currency: inputs.currency };
}

/**
 * Warnings for the panel. entrySeed lists the EBITDA gap first and the
 * "default multiple ignored" note second; once Base is saved, the multiple
 * is the user's own and only the gap still matters.
 */
function seedWarnings(seed: EntrySeed, saved: SavedCases): string[] {
  return saved.Base ? seed.warnings.slice(0, 1) : seed.warnings;
}

/**
 * The line catalogue and base column the workbook projects from (LTM or
 * last full year) — the panel's driver table and preview read these rather
 * than guessing from history.
 */
function modelStructure(inputs: LoadedDeal, catalogue: Catalogue, entry: ReturnType<typeof entryContext>) {
  const { base, baseCol } = entry;
  return {
    lines: catalogue.lines,
    baseValues: baseCol.values,
    // Latest full-year balance sheet (E3): Days working-capital base + net debt refinanced at entry.
    opening: openingBalances(inputs.history),
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

type SavedCases = Partial<Record<ModelCase, Partial<ModelAssumptions>>>;

/** Every saved case for the deal, keyed Low / Base / High. */
async function loadSavedCases(dealId: string, orgId: string): Promise<SavedCases> {
  const { data } = await supabase
    .from('DealModel')
    .select('name, assumptions')
    .eq('dealId', dealId)
    .eq('organizationId', orgId);
  const out: SavedCases = {};
  for (const row of (data ?? []) as Array<{ name?: string; assumptions?: Partial<ModelAssumptions> }>) {
    const c = MODEL_CASES.find((x) => CASE_ROW_NAMES[x] === row.name);
    if (c && row.assumptions) out[c] = row.assumptions;
  }
  return out;
}

/** `?case=` → a case, or a 400 already sent. */
function requestedCase(req: { query: Record<string, unknown> }, res: any): ModelCase | null {
  const c = parseCase(req.query.case);
  if (!c) res.status(400).json({ error: 'case must be Low, Base or High', code: 'INVALID_CASE' });
  return c;
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
  catalogue: Catalogue, seed: EntrySeed,
) {
  const edits = (body && typeof body === 'object' ? body : {}) as Partial<ModelAssumptions>;
  const merged: Partial<ModelAssumptions> = { ...base, ...edits };
  // A pre-E1 client posting growth / margin edits: migrate those, not the saved drivers.
  if (!edits.lineDrivers && (edits.revenueGrowthPct || edits.ebitdaMarginPct)) delete merged.lineDrivers;
  // …and pre-E3 scalar NWC / capex edits.
  if (!edits.balanceDrivers && (edits.nwcPctRevenue !== undefined || edits.capexPctRevenue !== undefined)) delete merged.balanceDrivers;
  const parsed = coherentAssumptions.safeParse(merged);
  return parsed.success ? resolveAssumptions(parsed.data, inputs.history, dealSeed(inputs, seed), catalogue) : base;
}

// GET /api/deals/:dealId/model?case=
router.get('/:dealId/model', async (req, res) => {
  const which = requestedCase(req, res);
  if (!which) return;
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const access = await verifyDealAccess(dealId, orgId);
    if (!access) return res.status(404).json({ error: 'Deal not found' });

    const inputs = await loadModelInputs(dealId, orgId);
    if (!inputs) return res.status(404).json({ error: 'Deal not found' });

    const saved = await loadSavedCases(dealId, orgId);
    const catalogue = buildLineCatalogue(inputs.history);
    const entry = entryContext(inputs, catalogue);
    const cases = resolveCases(saved, inputs.history, dealSeed(inputs, entry.seed), catalogue);

    res.json({
      case: which,
      assumptions: cases[which],
      isDerived: !saved[which],
      // Low / High never saved: seeded from Base with SCENARIO_DELTAS.
      seededFromBase: which !== 'Base' && !saved[which],
      history: inputs.history,
      ...modelStructure(inputs, catalogue, entry),
      warnings: seedWarnings(entry.seed, saved),
      currency: inputs.currency,
      unitScale: 'MILLIONS',
      sourceDocuments: inputs.documentNames,
    });
  } catch (error) {
    sendModelError(res, error);
  }
});

// GET /api/deals/:dealId/model/cases — Low / Base / High side by side
router.get('/:dealId/model/cases', async (req, res) => {
  try {
    const { dealId } = req.params;
    const orgId = getOrgId(req);
    const access = await verifyDealAccess(dealId, orgId);
    if (!access) return res.status(404).json({ error: 'Deal not found' });

    const inputs = await loadModelInputs(dealId, orgId);
    if (!inputs) return res.status(404).json({ error: 'Deal not found' });

    const saved = await loadSavedCases(dealId, orgId);
    const catalogue = buildLineCatalogue(inputs.history);
    const entry = entryContext(inputs, catalogue);
    const cases = resolveCases(saved, inputs.history, dealSeed(inputs, entry.seed), catalogue);
    const structure = modelStructure(inputs, catalogue, entry);

    res.json({
      cases: MODEL_CASES.map((c) => ({
        case: c,
        name: CASE_ROW_NAMES[c],
        saved: !!saved[c],
        assumptions: cases[c],
        // Same arithmetic as the workbook's Scenarios sheet.
        summary: structure.base ? summariseCase(catalogue.lines, structure.baseValues, cases[c], structure.opening) : null,
      })),
      deltas: SCENARIO_DELTAS,
      history: inputs.history,
      ...structure,
      warnings: seedWarnings(entry.seed, saved),
      currency: inputs.currency,
      unitScale: 'MILLIONS',
      sourceDocuments: inputs.documentNames,
    });
  } catch (error) {
    sendModelError(res, error);
  }
});

// PUT /api/deals/:dealId/model?case=
router.put('/:dealId/model', async (req, res) => {
  const which = requestedCase(req, res);
  if (!which) return;
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
          name: CASE_ROW_NAMES[which],
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

// POST /api/deals/:dealId/model/export?case= — returns the workbook
//   body: edits for `case` (legacy shape), or { cases: { Low?, Base?, High? }, activeCase? }
router.post('/:dealId/model/export', async (req, res) => {
  const which = requestedCase(req, res);
  if (!which) return;
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

    const saved = await loadSavedCases(dealId, orgId);
    const catalogue = buildLineCatalogue(inputs.history);
    const entry = entryContext(inputs, catalogue);
    const resolved = resolveCases(saved, inputs.history, dealSeed(inputs, entry.seed), catalogue);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const cases: CaseSet = { ...resolved };
    let activeCase = which;
    if (body.cases && typeof body.cases === 'object') {
      const edits = body.cases as Partial<Record<ModelCase, unknown>>;
      for (const c of MODEL_CASES) if (edits[c]) cases[c] = withEdits(resolved[c], edits[c], inputs, catalogue, entry.seed);
      activeCase = parseCase(body.activeCase) ?? which;
    } else {
      cases[which] = withEdits(resolved[which], body, inputs, catalogue, entry.seed);
    }

    const buffer = await buildModelWorkbook({
      assumptions: cases.Base,
      cases,
      activeCase,
      history: inputs.history,
      context: {
        dealName: inputs.deal.name,
        companyName: inputs.deal.companyName,
        currency: inputs.currency,
        unitScale: 'MILLIONS',
        sourceDocuments: inputs.documentNames,
        generatedAt: new Date().toISOString(),
        fallbackEntryEbitda: inputs.deal.ebitdaMillions,
        notes: [
          ...(inputs.history.length < 2
            ? ['Only one historical period was available — growth assumptions are defaults, not derived.']
            : []),
          // The EBITDA gap itself is already a CHECK note (coverNotes); add
          // why the default multiple isn't the deal record's.
          ...seedWarnings(entry.seed, saved).slice(1),
        ],
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

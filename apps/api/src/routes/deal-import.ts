import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { getOrgId } from '../middleware/orgScope.js';
import { supabase } from '../supabase.js';
import { log } from '../utils/logger.js';
import {
  parseCSV,
  parseExcel,
  parsePastedText,
  analyzeImportData,
  validateDealRow,
} from '../services/dealImportMapper.js';
import type { ColumnMapping } from '../services/dealImportMapper.js';
import { publicErrorMessage } from '../utils/aiErrors.js';

const router = Router();

// Multer for Excel file uploads (in-memory, 5MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (allowed.includes(file.mimetype) || file.originalname.endsWith('.csv') || file.originalname.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are supported'));
    }
  },
});

// ============================================
// POST /api/deals/import/analyze
// ============================================

const analyzeTextSchema = z.object({
  source: z.enum(['csv', 'paste']),
  rawData: z.string().min(1, 'No data provided'),
});

router.post('/analyze', upload.single('file'), async (req: Request, res: Response) => {
  try {
    let rows: Record<string, string>[];
    let source: 'csv' | 'excel' | 'paste';
    let parseWarnings: string[] = [];

    if (req.file) {
      // Excel file upload
      source = 'excel';
      const parsed = parseExcel(req.file.buffer);
      rows = parsed.rows;
      parseWarnings = parsed.warnings;
    } else {
      // CSV or pasted text (JSON body)
      const validation = analyzeTextSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
      }
      source = validation.data.source;
      rows = source === 'csv'
        ? parseCSV(validation.data.rawData)
        : parsePastedText(validation.data.rawData);
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: 'No data rows found. Please check your file.' });
    }

    if (rows.length > 500) {
      return res.status(400).json({
        error: `Too many rows (${rows.length}). Maximum 500 deals per import. Please split your file.`,
      });
    }

    const result = await analyzeImportData(rows, source);

    // Merge parse-level warnings (e.g., multi-sheet Excel) with AI warnings
    result.warnings = [...parseWarnings, ...result.warnings];

    res.json({
      success: true,
      ...result,
      // Also send all parsed rows so frontend can re-apply mapping client-side if user changes it
      allRows: rows,
    });
  } catch (error: any) {
    log.error('Deal import analyze error', error);
    const pub = publicErrorMessage(error, 'Failed to analyze import data');
    res.status(pub.statusCode ?? 500).json({ error: pub.message, code: pub.code });
  }
});

// ============================================
// POST /api/deals/import
// ============================================

const importDealSchema = z.object({
  name: z.string().min(1),
  companyName: z.string().min(1),
  stage: z.string().optional().default('INITIAL_REVIEW'),
  status: z.string().optional().default('ACTIVE'),
  dealSize: z.number().nullable().optional(),
  ebitda: z.number().nullable().optional(),
  revenue: z.number().nullable().optional(),
  irrProjected: z.number().nullable().optional(),
  mom: z.number().nullable().optional(),
  industry: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  priority: z.string().optional().default('MEDIUM'),
  tags: z.array(z.string()).optional(),
  targetCloseDate: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  customFields: z.record(z.string(), z.any()).optional().default({}),
});

const importRequestSchema = z.object({
  deals: z.array(z.record(z.string(), z.any())).min(1).max(500),
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const validation = importRequestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.errors });
    }

    const orgId = getOrgId(req);
    const { deals } = validation.data;
    const results = {
      imported: 0,
      failed: 0,
      companiesCreated: 0,
      errors: [] as Array<{ row: number; reason: string }>,
    };

    // ---- Phase 1: Pre-fetch all existing deal names (case-insensitive) ----
    // Supabase returns max 1000 rows by default — paginate to get all
    const existingDealNames = new Set<string>();
    let dealOffset = 0;
    const PAGE_SIZE = 1000;
    while (true) {
      const { data: dealPage } = await supabase
        .from('Deal')
        .select('name')
        .eq('organizationId', orgId)
        .range(dealOffset, dealOffset + PAGE_SIZE - 1);

      if (!dealPage || dealPage.length === 0) break;
      for (const d of dealPage) {
        existingDealNames.add(d.name.toLowerCase().trim());
      }
      if (dealPage.length < PAGE_SIZE) break;
      dealOffset += PAGE_SIZE;
    }

    // ---- Phase 2: Pre-fetch all existing companies ----
    const { data: existingCompanies } = await supabase
      .from('Company')
      .select('id, name')
      .eq('organizationId', orgId)
      .limit(5000);

    const companyCache = new Map<string, string>();
    for (const c of existingCompanies || []) {
      companyCache.set(c.name.toLowerCase().trim(), c.id);
    }

    // ---- Phase 3: Validate all rows + detect duplicates upfront ----
    const validatedDeals: Array<{ index: number; deal: z.infer<typeof importDealSchema> }> = [];

    for (let i = 0; i < deals.length; i++) {
      const rowValidation = validateDealRow(deals[i], i);
      if (!rowValidation.valid) {
        results.failed++;
        results.errors.push({ row: i + 1, reason: rowValidation.errors.join('; ') });
        continue;
      }

      const parsed = importDealSchema.safeParse(deals[i]);
      if (!parsed.success) {
        results.failed++;
        results.errors.push({ row: i + 1, reason: parsed.error.errors.map(e => e.message).join('; ') });
        continue;
      }

      const deal = parsed.data;
      const nameKey = deal.name.toLowerCase().trim();

      // Check against existing deals in DB (case-insensitive)
      if (existingDealNames.has(nameKey)) {
        results.failed++;
        results.errors.push({ row: i + 1, reason: `Duplicate deal name: "${deal.name}" already exists` });
        continue;
      }

      // Check against deals earlier in THIS import batch (prevent intra-file duplicates)
      if (validatedDeals.some(vd => vd.deal.name.toLowerCase().trim() === nameKey)) {
        results.failed++;
        results.errors.push({ row: i + 1, reason: `Duplicate deal name within import: "${deal.name}"` });
        continue;
      }

      validatedDeals.push({ index: i, deal });
    }

    // ---- Phase 4: Create missing companies in batch ----
    // Use Map keyed by lowercase to deduplicate case variants (e.g., "Acme Corp" vs "acme corp")
    const newCompanyMap = new Map<string, string>(); // lowercase → original name (first occurrence wins)
    for (const { deal } of validatedDeals) {
      const key = deal.companyName.toLowerCase().trim();
      if (!companyCache.has(key) && !newCompanyMap.has(key)) {
        newCompanyMap.set(key, deal.companyName);
      }
    }

    if (newCompanyMap.size > 0) {
      // Batch-insert new companies (groups of 50)
      const companyBatches = Array.from(newCompanyMap.values());
      for (let b = 0; b < companyBatches.length; b += 50) {
        const batch = companyBatches.slice(b, b + 50).map(name => {
          // Find a deal with this company to get the industry
          const matchingDeal = validatedDeals.find(
            vd => vd.deal.companyName.toLowerCase().trim() === name.toLowerCase().trim()
          );
          return {
            name,
            industry: matchingDeal?.deal.industry || null,
            organizationId: orgId,
          };
        });

        const { data: created, error: companyErr } = await supabase
          .from('Company')
          .insert(batch)
          .select('id, name');

        if (companyErr) {
          log.error('Batch company create error', companyErr);
        } else if (created) {
          for (const c of created) {
            companyCache.set(c.name.toLowerCase().trim(), c.id);
            results.companiesCreated++;
          }
        }
      }
    }

    // ---- Phase 5: Batch-insert deals (groups of 50) ----
    for (let b = 0; b < validatedDeals.length; b += 50) {
      const batch = validatedDeals.slice(b, b + 50);
      const dealRows: Array<{ rowIndex: number; data: Record<string, any> }> = [];

      for (const { index, deal } of batch) {
        const companyId = companyCache.get(deal.companyName.toLowerCase().trim());
        if (!companyId) {
          results.failed++;
          results.errors.push({ row: index + 1, reason: `Company not found: "${deal.companyName}"` });
          continue;
        }

        dealRows.push({
          rowIndex: index,
          data: {
            name: deal.name,
            companyId,
            stage: deal.stage,
            status: deal.status,
            dealSize: deal.dealSize,
            ebitda: deal.ebitda,
            revenue: deal.revenue,
            irrProjected: deal.irrProjected,
            mom: deal.mom,
            industry: deal.industry,
            description: deal.description,
            priority: deal.priority,
            tags: deal.tags || [],
            targetCloseDate: deal.targetCloseDate,
            source: deal.source,
            customFields: deal.customFields || {},
            icon: 'business_center',
            organizationId: orgId,
          },
        });
      }

      if (dealRows.length > 0) {
        const insertData = dealRows.map(r => r.data);
        const { data: inserted, error: dealErr } = await supabase
          .from('Deal')
          .insert(insertData)
          .select('id');

        if (dealErr) {
          log.error('Batch deal insert error', dealErr);
          // Fall back to individual inserts for this batch
          for (const { rowIndex, data } of dealRows) {
            const { error: singleErr } = await supabase
              .from('Deal')
              .insert(data);

            if (singleErr) {
              results.failed++;
              results.errors.push({ row: rowIndex + 1, reason: singleErr.message });
            } else {
              results.imported++;
            }
          }
        } else {
          results.imported += inserted?.length || dealRows.length;
        }
      }
    }

    log.info('Deal import complete', {
      total: deals.length,
      imported: results.imported,
      failed: results.failed,
      companiesCreated: results.companiesCreated,
    });

    res.status(201).json({ success: true, ...results });
  } catch (error: any) {
    log.error('Deal import error', error);
    const pub = publicErrorMessage(error, 'Failed to import deals');
    res.status(pub.statusCode ?? 500).json({ error: pub.message, code: pub.code });
  }
});

export default router;

// ─── POST /outreach/import/private-circle, /outreach/import/clay-csv ─────
// File imports — Private Circle (no API, ~100-200 row export cap) and Clay
// (real-time webhook push is gated behind a paid plan upgrade, confirmed in
// Clay's own UI — export is the workaround, available on every plan).
// Accepts CSV or Excel (.xlsx/.xls) — real exports from both tools have
// turned out to be Excel files in practice, not CSV, so both are supported
// via dealImportMapper.ts's parseCSV/parseExcel (same parsers deal-import.ts
// already uses), converging on the same Record<string,string>[] row shape
// before either hits the shared engine.
//
// Mounted in the same requireCiceroCapital-gated router chain as
// outreach.ts/outreach-replyio.ts (authenticated — a human uploads a file
// they exported themselves, unlike the Clay *webhook* path in
// outreach-clay-import-webhook.ts, which is unauthenticated since Clay
// calls it directly). Multer pattern matches routes/deal-import.ts exactly
// (memory storage, 5MB cap).
//
// Orchestration for each source lives in services/outreachPrivateCircleImport.ts
// / services/outreachClayCsvImport.ts, both thin wrappers over the shared
// services/outreachCsvImport.ts engine. This route's job is the multipart
// handling, picking the right parser for the uploaded file's type, the
// shared post-import auto-enrichment trigger, and response shaping —
// factored into runFileImportRoute() below so the two endpoints don't
// duplicate it.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { parseCSV, parseExcel } from '../services/dealImportMapper.js';
import { importPrivateCircleCsv } from '../services/outreachPrivateCircleImport.js';
import { importClayCsv } from '../services/outreachClayCsvImport.js';
import { enrichAndPersistOutreachContact } from '../services/outreachEnrichment.js';
import type { CsvImportResult } from '../services/outreachCsvImport.js';

const router = Router();

const EXCEL_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // legacy .xls
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isCsv = file.mimetype === 'text/csv' || name.endsWith('.csv');
    const isExcel = EXCEL_MIMETYPES.has(file.mimetype) || name.endsWith('.xlsx') || name.endsWith('.xls');
    if (isCsv || isExcel) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV or Excel (.xlsx/.xls) files are supported for this import'));
    }
  },
});

/** Parses an uploaded file's buffer into rows, picking CSV or Excel based on filename/mimetype. */
function parseUploadedFile(file: Express.Multer.File): { rows: Record<string, string>[]; warnings: string[] } {
  const name = file.originalname.toLowerCase();
  const isExcel = EXCEL_MIMETYPES.has(file.mimetype) || name.endsWith('.xlsx') || name.endsWith('.xls');
  if (isExcel) {
    return parseExcel(file.buffer);
  }
  return { rows: parseCSV(file.buffer.toString('utf-8')), warnings: [] };
}

/**
 * Shared body for both file import endpoints: parse (CSV or Excel), run the
 * source-specific importer, auto-enrich clean creates missing an email, log,
 * and shape the response. Only the importer function and log label differ
 * per source.
 */
async function runFileImportRoute(
  req: Request,
  res: Response,
  sourceLabel: string,
  runImport: (orgId: string, rows: Record<string, string>[]) => Promise<CsvImportResult>,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded — attach a CSV or Excel file as "file"' });
      return;
    }

    const orgId = getOrgId(req);

    let rows: Record<string, string>[];
    try {
      const parsed = parseUploadedFile(req.file);
      rows = parsed.rows;
      if (parsed.warnings.length > 0) {
        log.warn(`${sourceLabel} import: parser warnings`, { warnings: parsed.warnings });
      }
    } catch (parseErr) {
      log.error(`${sourceLabel} import: failed to parse uploaded file`, parseErr);
      res.status(400).json({ error: parseErr instanceof Error ? parseErr.message : 'Could not read that file' });
      return;
    }

    const importResult = await runImport(orgId, rows);

    // Auto-enrichment pass — only clean creates (never updates, never
    // flagged-for-review rows a human still has to resolve first), and only
    // when the imported row had no email. Awaited (not fire-and-forget):
    // there's no job-status UI to check back on later, and
    // enrichAndPersistOutreachContact already has its own internal
    // per-provider timeouts, so this can't hang indefinitely.
    let enriched = 0;
    for (const contactId of importResult.createdContactIdsMissingEmail) {
      try {
        const result = await enrichAndPersistOutreachContact(orgId, contactId);
        if (result.attempted && result.emailFilled) enriched++;
      } catch (err) {
        log.warn('outreach-import: auto-enrichment failed for one contact, continuing batch', {
          contactId,
          sourceLabel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info(`${sourceLabel} import complete`, {
      orgId,
      received: importResult.received,
      created: importResult.created,
      updated: importResult.updated,
      flaggedForReview: importResult.flaggedForReview,
      unmappable: importResult.unmappable,
      enriched,
    });

    res.json({
      received: importResult.received,
      created: importResult.created,
      updated: importResult.updated,
      flaggedForReview: importResult.flaggedForReview,
      enriched,
    });
  } catch (error) {
    log.error(`${sourceLabel} import error`, error);
    const message = error instanceof Error ? error.message : `Failed to import ${sourceLabel} file`;
    res.status(500).json({ error: message });
  }
}

router.post('/import/private-circle', upload.single('file'), (req, res) =>
  runFileImportRoute(req, res, 'Private Circle', importPrivateCircleCsv),
);

router.post('/import/clay-csv', upload.single('file'), (req, res) =>
  runFileImportRoute(req, res, 'Clay', importClayCsv),
);

export default router;

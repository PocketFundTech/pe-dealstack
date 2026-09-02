// ─── POST /outreach/import/private-circle, /outreach/import/clay-csv ─────
// File imports — Private Circle (no API, ~100-200 row export cap) and Clay
// (real-time webhook push is gated behind a paid plan upgrade, confirmed in
// Clay's own UI — export is the workaround, available on every plan).
// Accepts CSV or Excel (.xlsx/.xls) — real exports from both tools have
// turned out to be Excel files in practice, not CSV.
//
// Excel parsing uses outreachCsvImport.ts's parseExcelWithHeaderDetection,
// NOT dealImportMapper.ts's parseExcel — confirmed against a real Private
// Circle export that opens with a title row and a blank spacer row before
// the real headers on row 4, which a fixed "row 1 is headers" assumption
// (parseExcel's behavior, fine for its other callers) silently turns into
// "zero rows have a resolvable company name." Detection needs the target
// columnMap to know what a real header looks like, so it's passed in per
// source. CSV still goes through the plain parseCSV — real exports seen so
// far are all Excel, so this hasn't needed the same treatment.
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
// handling, picking + running the right parser for the uploaded file's type,
// the shared post-import auto-enrichment trigger, and response shaping —
// factored into runFileImportRoute() below so the two endpoints don't
// duplicate it.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { parseCSV } from '../services/dealImportMapper.js';
import { importPrivateCircleCsv, PRIVATE_CIRCLE_COLUMN_MAP } from '../services/outreachPrivateCircleImport.js';
import { importClayCsv, CLAY_CSV_COLUMN_MAP } from '../services/outreachClayCsvImport.js';
import { enrichAndPersistOutreachContact } from '../services/outreachEnrichment.js';
import { parseExcelWithHeaderDetection, type CsvColumnMap, type CsvImportResult } from '../services/outreachCsvImport.js';

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

/** Parses an uploaded file's buffer into rows, picking CSV or (header-detecting) Excel based on filename/mimetype. */
function parseUploadedFile(
  file: Express.Multer.File,
  columnMap: CsvColumnMap,
): { rows: Record<string, string>[]; warnings: string[] } {
  const name = file.originalname.toLowerCase();
  const isExcel = EXCEL_MIMETYPES.has(file.mimetype) || name.endsWith('.xlsx') || name.endsWith('.xls');
  if (isExcel) {
    return parseExcelWithHeaderDetection(file.buffer, columnMap);
  }
  return { rows: parseCSV(file.buffer.toString('utf-8')), warnings: [] };
}

/**
 * Shared body for both file import endpoints: parse (CSV or Excel), run the
 * source-specific importer, auto-enrich clean creates missing an email, log,
 * and shape the response. Only the importer function, column map, and log
 * label differ per source.
 */
async function runFileImportRoute(
  req: Request,
  res: Response,
  sourceLabel: string,
  columnMap: CsvColumnMap,
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
      const parsed = parseUploadedFile(req.file, columnMap);
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
      unmappable: importResult.unmappable,
      enriched,
    });
  } catch (error) {
    log.error(`${sourceLabel} import error`, error);
    const message = error instanceof Error ? error.message : `Failed to import ${sourceLabel} file`;
    res.status(500).json({ error: message });
  }
}

router.post('/import/private-circle', upload.single('file'), (req, res) =>
  runFileImportRoute(req, res, 'Private Circle', PRIVATE_CIRCLE_COLUMN_MAP, importPrivateCircleCsv),
);

router.post('/import/clay-csv', upload.single('file'), (req, res) =>
  runFileImportRoute(req, res, 'Clay', CLAY_CSV_COLUMN_MAP, importClayCsv),
);

export default router;

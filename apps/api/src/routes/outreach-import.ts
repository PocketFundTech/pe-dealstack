// ─── POST /outreach/import/private-circle, /outreach/import/clay-csv ─────
// CSV imports — Private Circle (no API, ~100-200 row export cap) and Clay
// (real-time webhook push is gated behind a paid plan upgrade, confirmed in
// Clay's own UI — CSV export is the workaround, available on every plan).
//
// Mounted in the same requireCiceroCapital-gated router chain as
// outreach.ts/outreach-replyio.ts (authenticated — a human uploads a file
// they exported themselves, unlike the Clay *webhook* path in
// outreach-clay-import-webhook.ts, which is unauthenticated since Clay
// calls it directly).  Multer pattern matches routes/deal-import.ts exactly
// (memory storage, 5MB cap, CSV/Excel mime filter).
//
// Orchestration for each source lives in services/outreachPrivateCircleImport.ts
// / services/outreachClayCsvImport.ts, both thin wrappers over the shared
// services/outreachCsvImport.ts engine. This route's job is the multipart
// handling, the shared post-import auto-enrichment trigger, and response
// shaping — factored into runCsvImportRoute() below so the two endpoints
// don't duplicate it.

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { importPrivateCircleCsv } from '../services/outreachPrivateCircleImport.js';
import { importClayCsv } from '../services/outreachClayCsvImport.js';
import { enrichAndPersistOutreachContact } from '../services/outreachEnrichment.js';
import type { CsvImportResult } from '../services/outreachCsvImport.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['text/csv', 'application/vnd.ms-excel'];
    if (allowed.includes(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are supported for this import'));
    }
  },
});

/**
 * Shared body for both CSV import endpoints: run the source-specific
 * importer, auto-enrich clean creates missing an email, log, and shape the
 * response. Only the importer function and log label differ per source.
 */
async function runCsvImportRoute(
  req: Request,
  res: Response,
  sourceLabel: string,
  runImport: (orgId: string, csvText: string) => Promise<CsvImportResult>,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded — attach a CSV as "file"' });
      return;
    }

    const orgId = getOrgId(req);
    const csvText = req.file.buffer.toString('utf-8');

    const importResult = await runImport(orgId, csvText);

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

    log.info(`${sourceLabel} CSV import complete`, {
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
    log.error(`${sourceLabel} CSV import error`, error);
    const message = error instanceof Error ? error.message : `Failed to import ${sourceLabel} CSV`;
    res.status(500).json({ error: message });
  }
}

router.post('/import/private-circle', upload.single('file'), (req, res) =>
  runCsvImportRoute(req, res, 'Private Circle', importPrivateCircleCsv),
);

router.post('/import/clay-csv', upload.single('file'), (req, res) =>
  runCsvImportRoute(req, res, 'Clay', importClayCsv),
);

export default router;

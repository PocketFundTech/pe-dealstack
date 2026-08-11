// ─── /api/firm-teaser router ─────────────────────────────────────────
// CRUD for the firm's named investment-criteria profiles, plus a non-persisted
// preview endpoint that powers the settings "GEN" button.
//
// All routes are org-scoped via getOrgId(req).

import { Router } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';
import { extractTextFromPDF, upload } from './ingest-shared.js';
import { extractTextFromExcel, isExcelFile } from '../services/excelFinancialExtractor.js';
import type { TeaserProfile } from '../services/firmTeaserService.js';

const router = Router();

// Cap the text returned to the client + later fed into GEN. Keeps the grounding
// context bounded (the system-prompt author doesn't need the whole document) and
// avoids shipping a multi-megabyte string back over the wire.
const MAX_CONTEXT_CHARS = 20000;

// ─── Validation schemas ─────────────────────────────────────────────

const criterionSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string(),
});

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  criteria: z.array(criterionSchema),
  contextText: z.string().optional(),
  updatedAt: z.string(),
});

const saveBodySchema = z.object({
  profiles: z.array(profileSchema),
});

const generatePromptBodySchema = z.object({
  name: z.string().optional(),
  notes: z.string().optional(),
  criteria: z.array(criterionSchema),
  contextText: z.string().optional(),
});

// ─── GET /api/firm-teaser → { profiles } ────────────────────────────
router.get('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { getFirmTeaserConfig } = await import('../services/firmTeaserService.js');
    const config = await getFirmTeaserConfig(orgId);
    res.json({ profiles: config.profiles });
  } catch (error) {
    log.error('firm-teaser: GET failed', error);
    res.status(500).json({ error: 'Failed to load firm teaser profiles' });
  }
});

// ─── PUT /api/firm-teaser → { profiles } (with stale/cleanup side effects) ──
router.put('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const parsed = saveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const { saveFirmTeaserConfig } = await import('../services/firmTeaserService.js');
    const profiles = await saveFirmTeaserConfig(orgId, parsed.data.profiles as TeaserProfile[]);
    res.json({ profiles });
  } catch (error) {
    log.error('firm-teaser: PUT failed', error);
    res.status(500).json({ error: 'Failed to save firm teaser profiles' });
  }
});

// ─── POST /api/firm-teaser/extract-context → { text, filename, chars } (NOT persisted) ──
// Pulls plain text out of an uploaded doc so it can ground the GEN system-prompt
// authoring. Routes by mimetype to the shared extractors. Creates NO Deal and
// writes NO DB — the text is returned to the client, which may pass it back as
// `contextText` to generate-prompt. Returned text is capped at MAX_CONTEXT_CHARS.
router.post('/extract-context', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const mimeType = file.mimetype;
    const filename = file.originalname;

    let extractedText: string | null = null;

    if (mimeType === 'application/pdf') {
      const extraction = await extractTextFromPDF(file.buffer, filename);
      if (!extraction) {
        return res.status(422).json({
          error:
            "Couldn't extract text from this PDF. It may be encrypted, password-protected, or malformed — try a different copy.",
        });
      }
      extractedText = extraction.text.replace(/\u0000/g, '');
      if (extraction.sparse && extractedText.trim().length < 100) {
        return res.status(422).json({
          error:
            "Couldn't extract text from this PDF. It appears to be image-only or scanned — please upload a text-based PDF.",
        });
      }
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimeType === 'application/msword'
    ) {
      const { extractTextFromWord } = await import('../services/documentParser.js');
      extractedText = await extractTextFromWord(file.buffer);
      if (!extractedText) {
        return res.status(400).json({ error: 'Failed to extract text from Word document' });
      }
    } else if (mimeType === 'text/plain') {
      extractedText = file.buffer.toString('utf-8');
    } else if (isExcelFile(mimeType, filename)) {
      extractedText = extractTextFromExcel(file.buffer);
      if (!extractedText) {
        return res.status(400).json({ error: 'Excel file appears empty or has no readable data' });
      }
    } else {
      return res.status(400).json({
        error: 'Unsupported file type',
        supported: ['PDF (.pdf)', 'Word (.docx, .doc)', 'Excel (.xlsx, .xls)', 'Text (.txt)'],
      });
    }

    const text = (extractedText ?? '').replace(/\u0000/g, '').slice(0, MAX_CONTEXT_CHARS);
    res.json({ text, filename, chars: text.length });
  } catch (error) {
    log.error('firm-teaser: extract-context failed', error);
    const message = error instanceof Error ? error.message : 'Failed to extract document text';
    res.status(500).json({ error: 'Failed to extract document text', message });
  }
});

// ─── POST /api/firm-teaser/generate-prompt → { systemPrompt } (NOT persisted) ──
// Expands the user's rough recommendations + criteria into an elaborate system
// prompt for the settings "GEN" button. Auth/org-scope is enforced by the
// middleware chain; this route reads/writes no org-scoped data.
router.post('/generate-prompt', async (req, res) => {
  try {
    const parsed = generatePromptBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }

    const { generateProfilePrompt } = await import('../services/firmTeaserService.js');
    const systemPrompt = await generateProfilePrompt(parsed.data);
    res.json({ systemPrompt });
  } catch (error) {
    log.error('firm-teaser: generate-prompt failed', error);
    const message = error instanceof Error ? error.message : 'Failed to generate system prompt';
    res.status(500).json({ error: 'Failed to generate system prompt', message });
  }
});

export default router;

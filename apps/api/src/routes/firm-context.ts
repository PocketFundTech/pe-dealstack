// ─── /api/firm-context router ───────────────────────────────────────
// CRUD + generation for the firm's single AI-generated "house view" context
// document, stored on Organization.settings.firmContext.
//
//   GET  /            → { firmContext: {...} | null }
//   POST /generate    → { text, generatedAt, sourcesUsed }
//   PUT  /  { text }  → { ok: true }
//
// All routes are org-scoped via getOrgId(req).

import { Router } from 'express';
import { z } from 'zod';
import { getOrgId } from '../middleware/orgScope.js';
import { log } from '../utils/logger.js';

const router = Router();

const saveBodySchema = z.object({
  text: z.string(),
});

// ─── GET /api/firm-context → { firmContext } ────────────────────────
router.get('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { getFirmContext } = await import('../services/firmContextService.js');
    const firmContext = await getFirmContext(orgId);
    res.json({ firmContext });
  } catch (error) {
    log.error('firm-context: GET failed', error);
    res.status(500).json({ error: 'Failed to load firm context' });
  }
});

// ─── POST /api/firm-context/generate → { text, generatedAt, sourcesUsed } ──
router.post('/generate', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const { generateFirmContext } = await import('../services/firmContextService.js');
    const ctx = await generateFirmContext(orgId);
    res.json(ctx);
  } catch (error) {
    log.error('firm-context: generate failed', error);
    const message = error instanceof Error ? error.message : 'Failed to generate firm context';
    res.status(500).json({ error: 'Failed to generate firm context', message });
  }
});

// ─── PUT /api/firm-context { text } → { ok: true } ──────────────────
router.put('/', async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const parsed = saveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { saveFirmContext } = await import('../services/firmContextService.js');
    await saveFirmContext(orgId, parsed.data.text);
    res.json({ ok: true });
  } catch (error) {
    log.error('firm-context: PUT failed', error);
    res.status(500).json({ error: 'Failed to save firm context' });
  }
});

export default router;

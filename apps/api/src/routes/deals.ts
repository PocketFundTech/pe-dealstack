// ─── /api/deals router (barrel) ───────────────────────────────────
// All route handlers are split into focused sub-routers:
//   - deals-team.ts                 — team-member management endpoints
//   - deals-analysis.ts             — AI analysis endpoints
//   - deals-chat.ts                 — chat-related deal endpoints
//   - deals-financial-summaries.ts  — GET /financial-summaries (bulk)
//   - deals-extraction-debug.ts     — GET /:id/extraction-debug (audit dump)
//   - deals-reconcile.ts            — GET /:id/reconcile (Phase 1 audit)
//   - deals-list.ts                 — GET /stats/summary, GET /, GET /:id
//   - deals-mutate.ts               — POST /, POST /:id/follow-up-questions,
//                                      PATCH /:id, DELETE /:id
// Mount order matches the original monolithic file: more-specific
// sub-routers first (team/analysis/chat/financial-summaries — all
// literal paths that must match before the /:id catch-all in
// deals-list), then top-level CRUD.
//
// extraction-debug + reconcile use /:id/<literal> shapes which Express
// matches more specifically than the bare /:id catch-all in deals-list —
// but only when these routers run first, so they mount before dealsListRouter.

import { Router } from 'express';

import dealsTeamRouter from './deals-team.js';
import dealsAnalysisRouter from './deals-analysis.js';
import dealsChatRouter from './deals-chat.js';
import dealsFinancialSummariesRouter from './deals-financial-summaries.js';
import dealsExtractionDebugRouter from './deals-extraction-debug.js';
import dealsReconcileRouter from './deals-reconcile.js';
import dealsListRouter from './deals-list.js';
import dealsMutateRouter from './deals-mutate.js';

const router = Router();

router.use('/', dealsTeamRouter);
router.use('/', dealsAnalysisRouter);
router.use('/', dealsChatRouter);
router.use('/', dealsFinancialSummariesRouter);
router.use('/', dealsExtractionDebugRouter);
router.use('/', dealsReconcileRouter);
router.use('/', dealsListRouter);
router.use('/', dealsMutateRouter);

export default router;

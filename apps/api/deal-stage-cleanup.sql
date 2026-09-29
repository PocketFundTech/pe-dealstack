-- Deal stage cleanup (2026-09-30)
--
-- The pipeline only shows these stages:
--   INITIAL_REVIEW, DUE_DILIGENCE, IOI_SUBMITTED, LOI_SUBMITTED, NEGOTIATION,
--   CLOSING, PASSED, CLOSED_WON, CLOSED_LOST
-- Two writers saved other values, and those deals are invisible on the
-- Deals kanban:
--   - Data Room page "New data room" → stage 'SCREENING'
--   - Deal chat / assistant "change stage" → stage 'LOI_NEGOTIATION'
-- The code now only accepts the stages above. This moves existing deals onto
-- real stages. Data-only, idempotent — safe to re-run.

-- 1. See what will change (run first, optional):
-- SELECT stage, count(*) FROM public."Deal"
--  WHERE stage NOT IN ('INITIAL_REVIEW','DUE_DILIGENCE','IOI_SUBMITTED','LOI_SUBMITTED',
--                      'NEGOTIATION','CLOSING','PASSED','CLOSED_WON','CLOSED_LOST')
--  GROUP BY stage;

-- 2. Fix them.
UPDATE public."Deal" SET stage = 'INITIAL_REVIEW', "updatedAt" = now() WHERE stage = 'SCREENING';
UPDATE public."Deal" SET stage = 'LOI_SUBMITTED',  "updatedAt" = now() WHERE stage = 'LOI_NEGOTIATION';

-- 3. Verify — should return no rows. If any other stage shows up, tell the
--    dev team before changing it by hand.
-- SELECT stage, count(*) FROM public."Deal"
--  WHERE stage NOT IN ('INITIAL_REVIEW','DUE_DILIGENCE','IOI_SUBMITTED','LOI_SUBMITTED',
--                      'NEGOTIATION','CLOSING','PASSED','CLOSED_WON','CLOSED_LOST')
--  GROUP BY stage;

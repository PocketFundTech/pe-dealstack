-- One-off seed for isolated Outreach test orgs — safe-testing companions
-- to cicero-outreach-schema-migration.sql, which only ever seeds stages
-- for the real org (slug = 'cicero-capital'). Run each block AFTER that
-- org's founding user has signed up through the app's own "Create your
-- workspace" flow (that flow creates the Organization + first ADMIN user
-- itself — no manual user/auth creation needed here). Idempotent — safe
-- to re-run either block.
--
-- Confirmed orgs so far (both added to requireCiceroCapital's allowlist,
-- middleware/orgScope.ts):
--   - 'pocket-fund'                         — pushkarrathod12@gmail.com
--   - 'cicero-capital-test-mtmtzb0d-ieqa'   — deepkeswani10@gmail.com,
--     confirmed as a legitimate team signup before being wired up.

-- ─── Org 1: Pocket Fund ─────────────────────────────────────────────────
INSERT INTO "OutreachStage" ("organizationId", name, position)
SELECT u."organizationId", s.name, s.position
FROM "User" u
CROSS JOIN (VALUES
  ('Source', 1), ('Enrich', 2), ('Send', 3),
  ('Handle Reply', 4), ('Escalate', 5), ('Meeting Booked', 6)
) AS s(name, position)
WHERE u.email = 'pushkarrathod12@gmail.com'
  AND u."organizationId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OutreachStage" existing WHERE existing."organizationId" = u."organizationId"
  );

-- ─── Org 2: Cicero Capital Test ─────────────────────────────────────────
INSERT INTO "OutreachStage" ("organizationId", name, position)
SELECT u."organizationId", s.name, s.position
FROM "User" u
CROSS JOIN (VALUES
  ('Source', 1), ('Enrich', 2), ('Send', 3),
  ('Handle Reply', 4), ('Escalate', 5), ('Meeting Booked', 6)
) AS s(name, position)
WHERE u.email = 'deepkeswani10@gmail.com'
  AND u."organizationId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OutreachStage" existing WHERE existing."organizationId" = u."organizationId"
  );

-- Verify both landed:
SELECT o.name AS org_name, o.slug, os.name AS stage_name, os.position
FROM "OutreachStage" os
JOIN "Organization" o ON o.id = os."organizationId"
WHERE o.slug IN ('pocket-fund', 'cicero-capital-test-mtmtzb0d-ieqa')
ORDER BY o.slug, os.position;

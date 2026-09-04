-- One-off seed for a SECOND, isolated Outreach test org — safe-testing
-- companion to cicero-outreach-schema-migration.sql, which only ever seeds
-- stages for the real org (slug = 'cicero-capital'). Run this AFTER the
-- test org's founding user has signed up through the app's own "Create
-- your workspace" flow (that flow creates the Organization + first ADMIN
-- user itself — no manual user/auth creation needed here).
--
-- Matches the org by the founding user's email rather than by slug, since
-- signup slugs carry a random suffix (services/userService.ts's mkSlug())
-- and aren't predictable in advance. Idempotent — safe to re-run.

-- 1) Seed the same 6 default stages this org type expects.
INSERT INTO "OutreachStage" ("organizationId", name, position)
SELECT u."organizationId", s.name, s.position
FROM "User" u
CROSS JOIN (VALUES
  ('Source', 1),
  ('Enrich', 2),
  ('Send', 3),
  ('Handle Reply', 4),
  ('Escalate', 5),
  ('Meeting Booked', 6)
) AS s(name, position)
WHERE u.email = 'pushkarrathod12@gmail.com'  -- change if a different person founds the test org
  AND u."organizationId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OutreachStage" existing WHERE existing."organizationId" = u."organizationId"
  );

-- 2) Print the new org's id + slug — paste the slug back so it can be
--    added to requireCiceroCapital's allowlist (middleware/orgScope.ts).
--    Outreach stays 403 for this org until that slug is added and deployed.
SELECT o.id, o.slug, o.name
FROM "Organization" o
JOIN "User" u ON u."organizationId" = o.id
WHERE u.email = 'pushkarrathod12@gmail.com';

-- 3) Verify stages landed:
-- SELECT name, position FROM "OutreachStage" os
--   JOIN "User" u ON u."organizationId" = os."organizationId"
--   WHERE u.email = 'pushkarrathod12@gmail.com'
--   ORDER BY position;

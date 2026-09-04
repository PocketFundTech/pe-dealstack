-- Removes the orphaned Organization row auto-created by ishani@cicero-capital.in's
-- original self-serve signup (slug like 'cicero-capital-<timestamp>-<rand>'),
-- now that cicero-capital-reassign-user-migration.sql has moved her User row
-- onto the real 'cicero-capital' org. Only deletes orgs with zero rows in any
-- org-scoped table, so it's a no-op (not an error) if anything still points at
-- one. RUN AFTER cicero-capital-reassign-user-migration.sql. Idempotent -- safe
-- to re-run.

DELETE FROM public."Organization" o
WHERE o.slug LIKE 'cicero-capital-%'
  AND o.slug <> 'cicero-capital'
  AND NOT EXISTS (SELECT 1 FROM public."User" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Deal" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Company" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Contact" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Task" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Invitation" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."AuditLog" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Memo" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."MemoTemplate" WHERE "organizationId" = o.id)
  AND NOT EXISTS (SELECT 1 FROM public."Notification" WHERE "organizationId" = o.id);

-- Verify nothing dangling remains:
-- SELECT id, name, slug FROM public."Organization" WHERE slug LIKE 'cicero-capital-%';

-- Moves the existing signup for ishani@cicero-capital.in into the pre-created
-- Cicero Capital org (see cicero-capital-org-migration.sql, slug 'cicero-capital')
-- and promotes them to ADMIN. Self-serve signup always creates its own
-- Organization row (never attaches by name), so this realigns that row
-- instead of leaving an orphaned duplicate. Idempotent -- safe to re-run.
-- Run cicero-capital-org-migration.sql FIRST if you haven't already.

UPDATE public."User" u
SET "organizationId" = (SELECT id FROM public."Organization" WHERE slug = 'cicero-capital'),
    role = 'ADMIN'
FROM auth.users au
WHERE u."authId" = au.id
  AND au.email = 'ishani@cicero-capital.in';

-- Verify:
-- SELECT u.id, u.email, u.role, u."organizationId", o.name, o.slug
-- FROM public."User" u JOIN public."Organization" o ON o.id = u."organizationId"
-- WHERE u."authId" = (SELECT id FROM auth.users WHERE email = 'ishani@cicero-capital.in');

-- Onboards new client "Cicero Capital" as an Organization row. Idempotent (ON CONFLICT on slug) — safe to re-run.

INSERT INTO public."Organization" (name, slug)
VALUES ('Cicero Capital', 'cicero-capital')
ON CONFLICT (slug) DO NOTHING;

-- Verify:
-- SELECT id, name, slug FROM public."Organization" WHERE slug = 'cicero-capital';

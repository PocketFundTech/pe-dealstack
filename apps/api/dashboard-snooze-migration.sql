-- ============================================================
-- DashboardSnooze table — moves the dashboard "Today queue"'s
-- Snooze action from per-browser localStorage to the server, so a
-- snooze made on one device is respected everywhere.
-- Run once in Supabase SQL editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS public."DashboardSnooze" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES public."User"(id) ON DELETE CASCADE,
  -- e.g. "task:<taskId>", "unowned:<dealId>", "stale:<dealId>" — see
  -- apps/web-next/.../dashboard/triage.ts buildTodayQueue().
  "itemKey" TEXT NOT NULL,
  "until" TIMESTAMP WITH TIME ZONE NOT NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE ("userId", "itemKey")
);

CREATE INDEX IF NOT EXISTS idx_dashboard_snooze_user
  ON public."DashboardSnooze"("userId");

-- Speeds up the "only return still-active snoozes" read the API always
-- does (GET /snoozes filters until > now()).
CREATE INDEX IF NOT EXISTS idx_dashboard_snooze_until
  ON public."DashboardSnooze"("until");

-- ============================================================
-- Row Level Security
-- Same pattern as Watchlist: service role (server, via service key)
-- has full access; authenticated users can additionally read/write
-- their own rows directly as defense in depth. All real traffic goes
-- through the API (routes/snoozes.ts), which is org-agnostic by
-- design — a snooze is scoped to a user, not an organization.
-- ============================================================

ALTER TABLE public."DashboardSnooze" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON public."DashboardSnooze"
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users manage their own snoozes" ON public."DashboardSnooze"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public."User"
      WHERE "User".id = "DashboardSnooze"."userId"
        AND "User"."authId" = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public."User"
      WHERE "User".id = "DashboardSnooze"."userId"
        AND "User"."authId" = auth.uid()
    )
  );

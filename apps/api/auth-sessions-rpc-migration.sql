-- Active sessions without exposing the `auth` schema (QA #11, 1 Oct 2026)
-- Run in the Supabase SQL Editor. Idempotent — safe to re-run.
--
-- Settings → Security → Active sessions read auth.sessions through PostgREST,
-- which only works if `auth` is an exposed schema (OPS-2). It isn't, so the
-- list was always empty. These two SECURITY DEFINER functions give the API
-- (service_role only) exactly what it needs and nothing more. The code works
-- before this runs (it says "Session management unavailable").

CREATE OR REPLACE FUNCTION public.list_user_sessions(p_user_id uuid)
RETURNS TABLE (id uuid, user_id uuid, created_at timestamptz, updated_at timestamptz, user_agent text, ip text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
  SELECT s.id, s.user_id, s.created_at, s.updated_at, s.user_agent, host(s.ip)::text
    FROM auth.sessions s
   WHERE s.user_id = p_user_id
   ORDER BY COALESCE(s.updated_at, s.created_at) DESC;
$$;

CREATE OR REPLACE FUNCTION public.revoke_user_session(p_user_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, pg_temp
AS $$
DECLARE n integer;
BEGIN
  -- Refresh tokens cascade with the session; the access token in hand stays
  -- valid until it expires (Supabase default ≤ 1 hour).
  DELETE FROM auth.sessions WHERE id = p_session_id AND user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

-- Only the API's service role may call these — never browser clients.
REVOKE ALL ON FUNCTION public.list_user_sessions(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_user_session(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_user_sessions(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_session(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─── Verify ─────────────────────────────────────────────────────
-- select proname from pg_proc where proname in ('list_user_sessions','revoke_user_session');  -- 2 rows
-- select count(*) from public.list_user_sessions((select id from auth.users limit 1));         -- runs without error

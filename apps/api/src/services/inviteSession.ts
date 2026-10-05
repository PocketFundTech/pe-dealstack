import { createClient, type Session } from '@supabase/supabase-js';
import { log } from '../utils/logger.js';

/**
 * Sign a just-created invitee in and return their session, using a throwaway
 * anon client.
 *
 * Never call signUp/signInWithPassword on the shared service-role client in
 * ../supabase.ts: supabase-js stores the resulting session on that client and
 * then sends the USER's access token on every later query from this lambda,
 * silently swapping the backend's service role for the invitee's RLS-bound
 * identity.
 */
export async function createInviteeSession(email: string, password: string): Promise<Session | null> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  try {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      log.warn('Invite accept: could not open a session for the new user', { error: error.message });
      return null;
    }
    return data.session ?? null;
  } catch (err) {
    log.warn('Invite accept: session creation threw', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Aliases a mis-named Anthropic API key env var onto the name the app
 * actually reads (ANTHROPIC_API_KEY).
 *
 * Context: automation in this environment can add plain env vars in Vercel
 * but is blocked from writing secret values directly (see the "Vercel
 * project move" memory gotcha), so a founder adding a fresh key by hand can
 * end up naming it anything — on 2026-09-28 it landed as `Antropic_api_avise`
 * instead of `ANTHROPIC_API_KEY`. No code anywhere reads that name, so the
 * key silently did nothing.
 *
 * This module's only job is to run BEFORE anything else and copy that value
 * onto `ANTHROPIC_API_KEY`, so every existing call site (getAnthropicClient()
 * in ai/client.ts, the module-level client in services/anthropic.ts, the
 * Anthropic SDK's own internal env lookup, LangChain's ChatAnthropic, etc.)
 * picks it up with no other change. It takes priority over an existing
 * ANTHROPIC_API_KEY — the whole point of adding a new key by hand is to
 * replace one that has run out of credit or gone bad.
 *
 * Import this as the FIRST import (before any other import, including
 * dotenv) in every process entrypoint (app.ts, app-lite.ts, app-ai.ts) —
 * import order matters here: it must run before anthropic.ts's module-level
 * `const apiKey = process.env.ANTHROPIC_API_KEY` executes.
 *
 * If/when the founder renames the Vercel var to ANTHROPIC_API_KEY directly,
 * this becomes a harmless no-op (ANTHROPIC_KEY_ALIAS_ENV_VAR won't be set).
 * Safe to delete once that happens, or keep as a standing escape hatch —
 * add more names to the list below if it recurs under a different typo.
 */

const ALIAS_ENV_VAR_NAMES = ['Antropic_api_avise'];

for (const name of ALIAS_ENV_VAR_NAMES) {
  const value = process.env[name];
  if (value) {
    process.env.ANTHROPIC_API_KEY = value;
    break;
  }
}

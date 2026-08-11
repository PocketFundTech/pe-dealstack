/**
 * Date helpers for LLM prompt injection.
 *
 * LLM models have a training cutoff and don't know the current date. When a
 * prompt asks about "FY", "LTM", "current quarter", or "last N days", the
 * model defaults to its training-time view of "now" and silently drifts off
 * the real period. Every LLM-touching system prompt that does relative-time
 * inference MUST inject today's date at CALL TIME (not module load time, or
 * the value freezes when the Node process boots and stays wrong for the
 * lifetime of the server).
 */

/**
 * Returns today's date in ISO YYYY-MM-DD format, computed at call time.
 *
 * Always call this fresh per request — do NOT cache the return value in a
 * module-scope constant. The whole point is that the value must reflect the
 * real wall-clock day when the prompt is sent.
 */
export function getTodayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

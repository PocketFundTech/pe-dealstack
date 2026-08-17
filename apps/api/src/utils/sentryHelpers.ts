/**
 * Sentry helpers for agent and background-job error reporting.
 *
 * Task 3.5 wired Sentry into the global Express error handler. But many
 * errors never reach that path:
 *   - LangGraph agent code catches its own errors and returns a structured
 *     error state without throwing.
 *   - Fire-and-forget background jobs use `.catch(log.error)` which never
 *     reaches the Express response cycle.
 *
 * This helper centralizes the captureException + scope tagging pattern so
 * those errors surface in monitoring. The Sentry SDK is a no-op when
 * uninitialized (NODE_ENV !== 'production' or SENTRY_DSN unset), so this
 * is safe in dev/test.
 *
 * Refs: .planning/REMEDIATION_ROADMAP.md Phase 3 Task 3.6
 * Refs: .planning/codebase/CONCERNS.md §6.4, §8.1
 */

import * as Sentry from '@sentry/node';

export type SentryLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

/**
 * Capture an unexpected error from an agent or background job.
 *
 * Usage:
 *   captureAgentError(err, { agent: 'financialAgent', node: 'extract' });
 *   captureAgentError(err, { context: 'notifyDealTeam' }, 'warning');
 *
 * Tags are intentionally restricted to opaque identifiers (agent name,
 * node name, context label). Never put user input, document content,
 * tokens, or other PII into tags — they're indexed by Sentry and visible
 * to anyone with read access to the project.
 */
export function captureAgentError(
  err: unknown,
  tags: Record<string, string>,
  level: SentryLevel = 'error',
): void {
  // Guard so a Sentry SDK shape change can never crash the agent / route.
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(level);
      for (const [k, v] of Object.entries(tags)) {
        if (typeof v === 'string' && v.length > 0) {
          scope.setTag(k, v);
        }
      }
      Sentry.captureException(err);
    });
  } catch {
    // Swallow — monitoring failures must not break the caller.
  }
}

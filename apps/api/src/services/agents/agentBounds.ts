// ─── Shared LangGraph Agent Bounds ──────────────────────────────────
// Hard limits applied to every agent.invoke() call across the codebase.
// Without these, a malformed tool output can loop the ReAct/State graph
// up to LangGraph's default 25 iterations (each making an LLM call), and
// slow OpenAI responses can hang past Vercel's function limit while
// billing continues.
//
// Pattern:
//   const result = await runWithAgentBounds(
//     (config) => graph.invoke(input, config),
//     { timeoutMs: 30_000, recursionLimit: 10, envVar: 'MY_AGENT_TIMEOUT_MS', label: 'myAgent' }
//   );
//
// The runner constructs an AbortController, races graph.invoke() against a
// timer, and forwards the signal so the in-flight HTTP request to OpenAI is
// actually cancelled (not just abandoned).
//
// Refs: .planning/REMEDIATION_ROADMAP.md Phase 4 Task 4.3
// Refs: .planning/codebase/CONCERNS.md §3.5, §7.2

export interface AgentBoundsOptions {
  /** Hard timeout in milliseconds. Default depends on agent — see callers. */
  timeoutMs: number;
  /** Cap on LangGraph node iterations. Default 10 (LangGraph default is 25). */
  recursionLimit?: number;
  /** Optional env var that overrides timeoutMs (useful for tests). */
  envVar?: string;
  /** Label used in the timeout error message. */
  label?: string;
}

export interface AgentBoundsConfig {
  recursionLimit: number;
  signal: AbortSignal;
}

/**
 * Read the timeout from an env override if present, otherwise use the
 * default. Used in tests to compress 30s waits into 150ms.
 */
export function resolveTimeoutMs(defaultMs: number, envVar?: string): number {
  if (!envVar) return defaultMs;
  const override = Number(process.env[envVar]);
  return Number.isFinite(override) && override > 0 ? override : defaultMs;
}

/**
 * Wrap a LangGraph .invoke() / .compile().invoke() call with:
 *   1. A recursionLimit cap (default 10).
 *   2. An AbortController + Promise.race timeout. The signal is forwarded
 *      to LangGraph (which forwards to the underlying LLM client) so the
 *      in-flight HTTP request is cancelled.
 *
 * The caller passes a closure that receives the `{ recursionLimit, signal }`
 * config object and calls invoke() with whatever input shape that agent uses.
 * We can't take `graph` directly because LangGraph's invoke() signature varies
 * by graph type (StateGraph vs ReactAgent), but the config shape is uniform.
 */
export async function runWithAgentBounds<T>(
  invoker: (config: AgentBoundsConfig) => Promise<T>,
  opts: AgentBoundsOptions,
): Promise<T> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs, opts.envVar);
  const recursionLimit = opts.recursionLimit ?? 10;
  const label = opts.label ?? 'agent';

  const abortController = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      abortController.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      invoker({ recursionLimit, signal: abortController.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

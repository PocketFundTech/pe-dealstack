import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { wrapSDK } from 'langsmith/wrappers';
import { log } from '../utils/logger.js';

// ─── Auth resolution ────────────────────────────────────────────────
//
// Two ways to authenticate with the Anthropic API in this codebase:
//
//  1. ANTHROPIC_API_KEY — a standard API key (`sk-ant-api03-...`), sent as
//     the `x-api-key` header. Existing, unambiguous mechanism — takes
//     priority whenever set, so nobody already running with a key sees a
//     behaviour change.
//  2. ANTHROPIC_OAUTH_TOKEN — a Claude subscription OAuth access token
//     (`sk-ant-oat01-...`, e.g. minted via `claude setup-token` / the
//     Claude Code OAuth login flow). These authenticate differently: on
//     `Authorization: Bearer <token>` instead of `x-api-key`, and the
//     Messages API additionally requires the `anthropic-beta:
//     oauth-2025-04-20` header on that auth path — the SDK's `authToken`
//     option sets the Bearer header but does NOT add this beta header
//     automatically, so it's added explicitly below. See
//     docs/ENVIRONMENT_SETUP.md for the full writeup, including the
//     known token-expiry caveat (no refresh-token flow in this codebase).
//
// Passing both apiKey and authToken to the SDK is a hard error ("both ...
// set" is rejected by the API), so resolution is either/or, never both.

const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export type AnthropicAuthOptions =
  | { apiKey: string }
  | { authToken: string; defaultHeaders: Record<string, string> };

/**
 * Resolves how to authenticate with the Anthropic API from environment
 * variables, preferring `ANTHROPIC_API_KEY` and falling back to
 * `ANTHROPIC_OAUTH_TOKEN`. Returns null when neither is set. This is the
 * single source of truth for Anthropic auth resolution in this codebase —
 * other call sites (aiModels.ts, claudeFinancialClassifier.ts,
 * financialCrossVerify.ts, services/ai/client.ts, crossVerifyNode.ts,
 * llm.ts) should use this (or `hasAnthropicCredentials` /
 * `getChatAnthropicAuthFields` below) instead of re-checking
 * `process.env.ANTHROPIC_API_KEY` directly.
 */
export function resolveAnthropicAuth(): AnthropicAuthOptions | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { apiKey };

  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  if (oauthToken) {
    return { authToken: oauthToken, defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER } };
  }

  return null;
}

/**
 * True when Claude is reachable via either ANTHROPIC_API_KEY or
 * ANTHROPIC_OAUTH_TOKEN. Cheap check, no client construction — use this
 * wherever code today does `!!process.env.ANTHROPIC_API_KEY`.
 */
export function hasAnthropicCredentials(): boolean {
  return resolveAnthropicAuth() !== null;
}

/**
 * Auth fields to spread into `new ChatAnthropic({...})` (the
 * `@langchain/anthropic` wrapper used by several Claude call sites in this
 * codebase — claudeFinancialClassifier.ts, financialCrossVerify.ts,
 * crossVerifyNode.ts, llm.ts). ChatAnthropic only understands
 * `apiKey`/`anthropicApiKey` and throws "Anthropic API key not found" when
 * neither is set and no `createClient` override is supplied — it has no
 * native concept of a bearer-token OAuth client, and its `clientOptions`
 * pass-through is overridden by an explicit `apiKey: this.apiKey` at
 * construction time either way. So the OAuth path goes through
 * `createClient` (LangChain's escape hatch for supplying a fully custom
 * underlying client) rather than `clientOptions.authToken`, which
 * ChatAnthropic never reads. Returns null when neither credential is set.
 */
export function getChatAnthropicAuthFields():
  | { apiKey: string }
  | { createClient: (options: ClientOptions) => Anthropic }
  | null {
  const auth = resolveAnthropicAuth();
  if (!auth) return null;
  if ('apiKey' in auth) return { apiKey: auth.apiKey };

  return {
    createClient: (options: ClientOptions) =>
      new Anthropic({
        ...options,
        apiKey: undefined,
        authToken: auth.authToken,
        defaultHeaders: { ...options.defaultHeaders, ...auth.defaultHeaders },
      }),
  };
}

// ─── Client ─────────────────────────────────────────────────────────

const authOptions = resolveAnthropicAuth();

if (!authOptions) {
  log.warn('ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not set — Claude cross-verification disabled');
}

const rawClient = authOptions ? new Anthropic(authOptions) : null;

// Wrap with LangSmith tracing only when explicitly enabled. The wrapper is a
// proxy with the same surface as the SDK, so call sites that today invoke
// `anthropic.messages.create(...)` continue to work unchanged.
export const anthropic =
  rawClient && process.env.LANGSMITH_TRACING === 'true'
    ? wrapSDK(rawClient, { name: 'anthropic-sdk' })
    : rawClient;

export const isClaudeEnabled = () => !!anthropic;

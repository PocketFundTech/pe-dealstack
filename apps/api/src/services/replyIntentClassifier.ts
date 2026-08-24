// ─── Reply-intent classifier — monitor & flag, NOT act ──────────────
//
// Per the Outreach feature's own source deck: Claude's job on an inbound
// reply is to gauge intent and flag anything it can't confidently read for
// a human — it never decides next steps or takes autonomous action (no
// auto-reply, no auto stage-move). This module implements exactly that one
// human-checkpoint, nothing more. Called from both reply-detection paths —
// the on-demand poll (routes/outreach.ts POST /sync-replies) and the
// registered webhook (routes/outreach-webhooks.ts) — via
// services/outreachReplyRecorder.ts, so a reply gets the same read
// regardless of which path noticed it.
//
// ─── Calling convention ──────────────────────────────────────────────
// Small, bounded, single-purpose Claude call — same auth/model-selection
// idiom as services/claudeFinancialClassifier.ts (ChatAnthropic via
// getChatAnthropicAuthFields(), so this works whether the org has
// ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN set), but structured output via
// `.withStructuredOutput()` (the pattern used for small classification tasks
// elsewhere — see services/contactFollowUpSuggester.ts) rather than
// claudeFinancialClassifier's manual JSON-parse, since the output schema
// here is tiny and fixed rather than a large free-form extraction shape.
//
// ─── Confidence-gated flagging ────────────────────────────────────────
// The structured output carries `confident: boolean` alongside `intent`.
// `needsReview` is true whenever the read isn't clean: intent === 'unclear',
// OR the model itself set confident: false. Only a clean, confident read
// (any non-'unclear' intent with confident: true) gets needsReview: false
// with replyIntent populated — everything else is left for a human, per the
// design's "anything the system can't confidently read gets queued for a
// person, instead of guessed at." Callers persist replyIntent ONLY on the
// confident branch (see outreachReplyRecorder.ts) — a flagged read doesn't
// get a value that presents to a human as more certain than it is.
//
// Soft-fail throughout: no ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN, empty
// input, or a classification failure all return null (info/warn logged,
// never thrown) — the caller leaves replyIntent/needsReview untouched.

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { log } from '../utils/logger.js';
import { hasAnthropicCredentials, getChatAnthropicAuthFields } from './anthropic.js';

// ─── Config ──────────────────────────────────────────────────────────

/** Sonnet 4.6 — exact model ID per Anthropic SDK spec, matching
 *  claudeFinancialClassifier.ts. Do not append a date suffix. */
const SONNET_MODEL = 'claude-sonnet-4-6';

/** Tiny fixed output shape — a few hundred tokens is generous headroom. */
const MAX_OUTPUT_TOKENS = 300;

const REQUEST_TIMEOUT_MS = 30_000;

let cachedModel: ChatAnthropic | null = null;

function getModel(): ChatAnthropic | null {
  if (cachedModel) return cachedModel;
  const authFields = getChatAnthropicAuthFields();
  if (!authFields) return null;
  cachedModel = new ChatAnthropic({
    model: SONNET_MODEL,
    ...authFields,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    clientOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return cachedModel;
}

// ─── Taxonomy ────────────────────────────────────────────────────────

export const REPLY_INTENTS = [
  'interested',
  'not_interested',
  'meeting_request',
  'out_of_office',
  'unclear',
] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];

const classificationSchema = z.object({
  intent: z
    .enum(REPLY_INTENTS)
    .describe(
      'The single best-fit classification of the reply: interested (positive ' +
        'signal, wants to continue the conversation), not_interested (declining, ' +
        'opting out, or asking to stop), meeting_request (explicitly asking to ' +
        'schedule a call/meeting), out_of_office (an automated OOO/vacation ' +
        'auto-reply, not a real human response), or unclear (ambiguous, ' +
        "sarcastic, off-topic, or doesn't confidently fit any other category).",
    ),
  confident: z
    .boolean()
    .describe(
      'True only when the intent above is a confident, unambiguous read of the ' +
        'reply text alone. False for terse, mixed-signal, sarcastic, or ' +
        'otherwise ambiguous replies — when in doubt, set this to false rather ' +
        'than guessing.',
    ),
});

export interface ReplyIntentClassifierInput {
  replyText: string;
  name?: string | null;
  company?: string | null;
  /** The original outreach channel, e.g. 'proprietary' | 'broker'. */
  channel?: string | null;
}

export interface ReplyIntentClassification {
  intent: ReplyIntent;
  /**
   * True when this reply should be queued for a human instead of trusted
   * automatically (intent === 'unclear', or confident === false from the
   * model). Per the product's scope, this is a flag for a person to look
   * at — this module never decides or takes any next step itself.
   */
  needsReview: boolean;
}

/**
 * True when Claude is reachable (ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN
 * set). Callers can use this to skip the call entirely rather than relying
 * on classifyReplyIntent's null return, mirroring
 * isClaudeClassifierEnabled() in claudeFinancialClassifier.ts.
 */
export function isReplyIntentClassifierEnabled(): boolean {
  return hasAnthropicCredentials();
}

/**
 * Classifies a single reply's intent. Returns null (never throws) when
 * Claude isn't configured, the input has no usable text, or the call
 * itself fails — in every one of those cases the caller should leave
 * replyIntent/needsReview untouched on the contact, exactly like every
 * other optional integration in this feature area.
 */
export async function classifyReplyIntent(
  input: ReplyIntentClassifierInput,
): Promise<ReplyIntentClassification | null> {
  if (!hasAnthropicCredentials()) {
    log.info('replyIntentClassifier: skipped — ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN not set');
    return null;
  }

  const replyText = (input.replyText || '').trim();
  if (!replyText) {
    log.warn('replyIntentClassifier: skipped — empty reply text');
    return null;
  }

  const model = getModel();
  if (!model) {
    // Shouldn't happen (hasAnthropicCredentials() and getModel() resolve
    // from the same env check) — defensive fallback, same soft-fail shape.
    log.warn('replyIntentClassifier: skipped — Claude model unavailable');
    return null;
  }

  const contextLines = [
    input.name ? `Contact name: ${input.name}` : null,
    input.company ? `Company: ${input.company}` : null,
    input.channel ? `Original outreach channel: ${input.channel}` : null,
  ].filter((line): line is string => Boolean(line));

  const prompt = [
    'A prospect replied to an outbound outreach message. Classify the INTENT of',
    'their reply. You are only gauging intent for a human reviewer — you are not',
    'deciding or suggesting what happens next.',
    '',
    ...(contextLines.length ? [contextLines.join('\n'), ''] : []),
    'REPLY TEXT:',
    replyText.slice(0, 8000),
    '',
    'Classify into exactly one intent, and report whether you are confident in',
    'that read. If the reply is ambiguous, mixed-signal, sarcastic, extremely',
    'terse, or otherwise hard to read confidently, set confident: false rather',
    'than guessing — an uncertain read gets queued for a person instead.',
  ].join('\n');

  try {
    const structured = await model
      .withStructuredOutput(classificationSchema, {
        method: 'functionCalling',
        name: 'classify_reply_intent',
      })
      .invoke(
        [
          new SystemMessage(
            'You classify the intent of inbound replies to sales/outreach emails for ' +
              'a private-equity dealmaker. You gauge intent only — you never decide or ' +
              'suggest next steps. Return valid structured output only.',
          ),
          new HumanMessage(prompt),
        ],
        { runName: 'replyIntentClassifier', tags: ['outreach', 'reply-intent'] },
      );

    const result = classificationSchema.parse(structured);
    const needsReview = result.intent === 'unclear' || !result.confident;

    log.info('replyIntentClassifier: classified reply', {
      intent: result.intent,
      confident: result.confident,
      needsReview,
    });

    return { intent: result.intent, needsReview };
  } catch (err) {
    // SDK typed exceptions per shared/error-codes.md — most-specific first.
    // ChatAnthropic uses the bare SDK under the hood, so the same error
    // classes still surface through .invoke() rejections (same handling as
    // claudeFinancialClassifier.ts).
    if (err instanceof Anthropic.RateLimitError) {
      log.warn('replyIntentClassifier: rate limited');
    } else if (err instanceof Anthropic.AuthenticationError) {
      log.warn('replyIntentClassifier: authentication failed — check ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN');
    } else if (err instanceof Anthropic.APIError) {
      log.warn('replyIntentClassifier: API error', { status: err.status, message: err.message });
    } else {
      log.warn('replyIntentClassifier: classification failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Never throws past itself — a classification failure just leaves the
    // contact unclassified.
    return null;
  }
}

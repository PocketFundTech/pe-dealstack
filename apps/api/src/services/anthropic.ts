import Anthropic from '@anthropic-ai/sdk';
import { wrapSDK } from 'langsmith/wrappers';
import { log } from '../utils/logger.js';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  log.warn('ANTHROPIC_API_KEY not set — Claude cross-verification disabled');
}

const rawClient = apiKey ? new Anthropic({ apiKey }) : null;

// Wrap with LangSmith tracing only when explicitly enabled. The wrapper is a
// proxy with the same surface as the SDK, so call sites that today invoke
// `anthropic.messages.create(...)` continue to work unchanged.
export const anthropic =
  rawClient && process.env.LANGSMITH_TRACING === 'true'
    ? wrapSDK(rawClient, { name: 'anthropic-sdk' })
    : rawClient;

export const isClaudeEnabled = () => !!anthropic;

import { openai } from '../../../openai.js';
import { MODEL_FAST } from '../../../utils/aiModels.js';
import { log } from '../../../utils/logger.js';
import { incrementalUpdateSchema, type DealIncrementalUpdate } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, type DealSnapshot } from './prompt.js';

const MAX_BODY_CHARS = 8000;

export type { DealSnapshot } from './prompt.js';
export type { DealIncrementalUpdate } from './schema.js';
export { SENSITIVE_FIELDS } from './schema.js';

export interface IncrementalUpdateInput {
  deal: DealSnapshot;
  email: {
    subject: string;
    from: string;
    date: string;
    bodyText: string;
  };
}

export async function runDealIncrementalUpdate(
  input: IncrementalUpdateInput
): Promise<DealIncrementalUpdate | null> {
  if (!openai) {
    log.warn('dealIncrementalUpdate: no LLM client configured, skipping');
    return null;
  }

  const truncatedEmail = {
    ...input.email,
    bodyText:
      input.email.bodyText.length > MAX_BODY_CHARS
        ? input.email.bodyText.slice(0, MAX_BODY_CHARS) + '\n\n[body truncated]'
        : input.email.bodyText,
  };

  try {
    const completion = await openai.chat.completions.create(
      {
        model: MODEL_FAST,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ ...input, email: truncatedEmail }) },
        ],
        temperature: 0.1,
      },
      { signal: AbortSignal.timeout(20_000) }
    );

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const result = incrementalUpdateSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('dealIncrementalUpdate: schema validation failed', {
        errors: result.error.issues.slice(0, 3),
      });
      return null;
    }
    return result.data;
  } catch (err) {
    log.error('dealIncrementalUpdate: failed', err);
    return null;
  }
}

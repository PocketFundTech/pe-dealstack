import { openai } from '../../../openai.js';
import { MODEL_FAST } from '../../../utils/aiModels.js';
import { log } from '../../../utils/logger.js';
import { dealEmailClassifierSchema, type DealEmailClassification } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

// Body is truncated before sending to keep classifier cost predictable.
// Most deal-relevance signal is in subject + first ~2k chars; the full body
// goes to the dedicated extractor *after* a positive classification.
const MAX_BODY_CHARS = 4000;

export interface ClassifierInput {
  subject: string;
  fromName: string | null;
  fromEmail: string;
  toEmails: string[];
  date: string | null;
  bodyText: string;
}

export async function runDealEmailClassifier(
  input: ClassifierInput
): Promise<DealEmailClassification | null> {
  if (!openai) {
    log.warn('dealEmailClassifier: no LLM client configured, skipping');
    return null;
  }

  const truncatedBody =
    input.bodyText.length > MAX_BODY_CHARS
      ? input.bodyText.slice(0, MAX_BODY_CHARS) + '\n\n[body truncated]'
      : input.bodyText;

  try {
    const completion = await openai.chat.completions.create(
      {
        model: MODEL_FAST,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserPrompt({ ...input, bodyText: truncatedBody }),
          },
        ],
        temperature: 0.1,
      },
      { signal: AbortSignal.timeout(15_000) }
    );

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const result = dealEmailClassifierSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('dealEmailClassifier: schema validation failed', {
        errors: result.error.issues.slice(0, 3),
      });
      return null;
    }
    return result.data;
  } catch (err) {
    log.error('dealEmailClassifier: failed', err);
    return null;
  }
}

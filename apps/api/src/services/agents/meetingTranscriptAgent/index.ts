import { openai } from '../../../openai.js';
import { MODEL_FAST } from '../../../utils/aiModels.js';
import { log } from '../../../utils/logger.js';
import { meetingInsightSchema, type MeetingInsight } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

const MAX_TRANSCRIPT_CHARS = 60_000; // ~15k tokens, safely under context for 4.1-mini

export interface TranscriptAnalysisInput {
  title: string | null;
  attendees: { name: string | null; email: string | null }[];
  durationSeconds: number | null;
  transcript: string;
}

export async function runTranscriptAnalysis(
  input: TranscriptAnalysisInput
): Promise<MeetingInsight | null> {
  if (!openai) {
    log.warn('meetingTranscriptAgent: no LLM client configured, skipping');
    return null;
  }
  if (!input.transcript || input.transcript.trim().length === 0) {
    return null;
  }
  const truncatedInput: TranscriptAnalysisInput = {
    ...input,
    transcript:
      input.transcript.length > MAX_TRANSCRIPT_CHARS
        ? input.transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[transcript truncated]'
        : input.transcript,
  };

  try {
    const completion = await openai.chat.completions.create(
      {
        model: MODEL_FAST,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(truncatedInput) },
        ],
        temperature: 0.1,
      },
      { signal: AbortSignal.timeout(15_000) }
    );
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const result = meetingInsightSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('meetingTranscriptAgent: schema validation failed', {
        errors: result.error.issues.slice(0, 3),
      });
      return null;
    }
    return result.data;
  } catch (err) {
    log.error('meetingTranscriptAgent: failed', err);
    return null;
  }
}

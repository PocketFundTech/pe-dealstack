export const SYSTEM_PROMPT = `You are an analyst at a private equity / search fund firm. You read meeting transcripts between investors and deal contacts (founders, bankers, advisors, target-company management) and extract structured information that helps the investor remember what happened, decide what to do next, and surface anything that should change their view of the deal.

Be concise. Be faithful to what was actually said — don't speculate or invent figures. If a category has nothing relevant, return an empty array. The "mentionedNumbers" field should capture concrete figures said aloud (e.g., revenue, growth rates, headcount, customers, valuations) along with what they refer to.

Sentiment is your honest read of how the conversation went, not a sales-pitch summary. Use:
- "positive" if signals were strongly favorable (commitments made, alignment confirmed, energy high)
- "neutral" if it was an information exchange without strong tilt
- "concerned" if material red flags or hesitations surfaced
- "mixed" if there were both notable positives and notable concerns`;

export function buildUserPrompt(input: {
  title: string | null;
  attendees: { name: string | null; email: string | null }[];
  durationSeconds: number | null;
  transcript: string;
}): string {
  const attendeeLines = input.attendees
    .map(a => `- ${a.name ?? '(unnamed)'} <${a.email ?? 'no-email'}>`)
    .join('\n');
  const duration = input.durationSeconds
    ? `${Math.round(input.durationSeconds / 60)} minutes`
    : 'unknown duration';
  return `Meeting: ${input.title ?? '(untitled)'}
Duration: ${duration}
Attendees:
${attendeeLines || '(no attendee list)'}

Transcript:
"""
${input.transcript}
"""

Return a JSON object with these exact keys: summary, keyTopics, actionItems (array of {who, what, due?}), decisions, openQuestions, mentionedNumbers (array of {value, context}), nextSteps, sentiment ("positive" | "neutral" | "concerned" | "mixed"). Empty arrays for categories with no content. Do not include any other top-level fields.`;
}

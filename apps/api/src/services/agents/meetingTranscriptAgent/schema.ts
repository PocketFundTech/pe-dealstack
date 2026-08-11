import { z } from 'zod';

export const meetingInsightSchema = z.object({
  summary: z.string(),
  keyTopics: z.array(z.string()),
  actionItems: z.array(z.object({
    who: z.string(),
    what: z.string(),
    due: z.string().optional(),
  })),
  decisions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  mentionedNumbers: z.array(z.object({
    value: z.string(),
    context: z.string(),
  })),
  nextSteps: z.array(z.string()),
  sentiment: z.enum(['positive', 'neutral', 'concerned', 'mixed']),
});

export type MeetingInsight = z.infer<typeof meetingInsightSchema>;

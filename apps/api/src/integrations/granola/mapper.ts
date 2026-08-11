import { log } from '../../utils/logger.js';
import type { MeetingInsight } from '../../services/agents/meetingTranscriptAgent/schema.js';
import type { GranolaNoteWithTranscript } from './types.js';

export interface IntegrationActivityRow {
  integrationId: string;
  organizationId: string;
  userId: string;
  source: 'granola';
  externalId: string;
  type: 'MEETING';
  dealIds: string[];
  contactIds: string[];
  title: string;
  summary: string;
  occurredAt: string;
  durationSeconds: number | null;
  metadata: Record<string, unknown>;
  aiExtraction: MeetingInsight | null;
  rawTranscript: string;
}

function transcriptToText(note: GranolaNoteWithTranscript): string {
  return note.transcript
    .map(seg => `${seg.speakerName ?? '(speaker)'}: ${seg.text}`)
    .join('\n');
}

function computeDurationSeconds(note: GranolaNoteWithTranscript): number | null {
  if (!note.meetingStartedAt || !note.meetingEndedAt) return null;
  const start = Date.parse(note.meetingStartedAt);
  const end = Date.parse(note.meetingEndedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.floor((end - start) / 1000);
}

export async function granolaNoteToIntegrationActivity(params: {
  note: GranolaNoteWithTranscript;
  integrationId: string;
  organizationId: string;
  userId: string;
  dealIds: string[];
  contactIds: string[];
}): Promise<IntegrationActivityRow> {
  const { note, integrationId, organizationId, userId, dealIds, contactIds } = params;

  const durationSeconds = computeDurationSeconds(note);
  const occurredAt = note.meetingStartedAt ?? note.createdAt;
  const transcriptText = transcriptToText(note);

  let aiExtraction: MeetingInsight | null = null;
  try {
    const { runTranscriptAnalysis } = await import('../../services/agents/meetingTranscriptAgent/index.js');
    aiExtraction = await runTranscriptAnalysis({
      title: note.title,
      attendees: note.attendees,
      durationSeconds,
      transcript: transcriptText,
    });
  } catch (err) {
    log.warn('granola mapper: transcript agent threw, continuing without aiExtraction', {
      noteId: note.id,
      err: err instanceof Error ? err.message : String(err),
    });
    aiExtraction = null;
  }

  return {
    integrationId,
    organizationId,
    userId,
    source: 'granola',
    externalId: note.id,
    type: 'MEETING',
    dealIds,
    contactIds,
    title: note.title ?? 'Granola meeting',
    summary: note.summary ?? '',
    occurredAt,
    durationSeconds,
    metadata: {
      attendees: note.attendees,
      transcriptSegmentCount: note.transcript.length,
      providerCreatedAt: note.createdAt,
      providerUpdatedAt: note.updatedAt,
    },
    aiExtraction,
    rawTranscript: transcriptText,
  };
}

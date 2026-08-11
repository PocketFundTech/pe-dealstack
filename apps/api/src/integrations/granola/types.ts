// Shapes returned by the Granola public API (https://docs.granola.ai).
// Only the fields we consume are typed; the API may include more.

export interface GranolaNoteListResponse {
  data: GranolaNoteSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GranolaNoteSummary {
  id: string;
  title: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  meetingStartedAt: string | null;
  meetingEndedAt: string | null;
  attendees: GranolaAttendee[];
}

export interface GranolaNoteWithTranscript extends GranolaNoteSummary {
  summary: string | null;
  transcript: GranolaTranscriptSegment[];
}

export interface GranolaAttendee {
  email: string | null;
  name: string | null;
}

export interface GranolaTranscriptSegment {
  speakerEmail: string | null;
  speakerName: string | null;
  text: string;
  startedAtMs: number;
}

export interface GranolaUserInfo {
  email: string;
  name: string | null;
  plan: 'free' | 'pro' | 'business' | 'enterprise' | string;
}

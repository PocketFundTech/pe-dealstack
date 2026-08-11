/**
 * Core TypeScript types for the API
 * Provides type safety across routes, middleware, and services
 */

// Canonical enums live in @ai-crm/shared so apps/api and apps/web-next
// can't drift. Re-export here so existing import sites (`from '../types/index.js'`)
// keep working — the SOURCE moved, the import path didn't.
export { UserRole } from '@ai-crm/shared';
import type { UserRole } from '@ai-crm/shared';

// ============================================================
// User Types
// ============================================================

export interface User {
  id: string;
  authId: string;
  email: string;
  name: string | null;
  avatar: string | null;
  title: string | null;
  department: string | null;
  firmName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Note: Express Request is extended in middleware/auth.ts and middleware/requestId.ts
// Use req.user and req.requestId directly on Express.Request

// ============================================================
// Company Types
// ============================================================

export interface Company {
  id: string;
  name: string;
  industry: string | null;
  description: string | null;
  website: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Deal Types
// ============================================================

export type DealStage =
  | 'INITIAL_REVIEW'
  | 'SCREENING'
  | 'DUE_DILIGENCE'
  | 'IC_REVIEW'
  | 'NEGOTIATION'
  | 'CLOSED'
  | 'PASSED';

export type DealStatus = 'ACTIVE' | 'PASSED' | 'ON_HOLD' | 'PENDING_REVIEW';

export type DealPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface Deal {
  id: string;
  name: string;
  companyId: string | null;
  stage: DealStage;
  status: DealStatus;
  priority: DealPriority;
  irrProjected: number | null;
  mom: number | null;
  ebitda: number | null;
  revenue: number | null;
  industry: string | null;
  dealSize: number | null;
  description: string | null;
  aiThesis: string | null;
  icon: string | null;
  assignedTo: string | null;
  tags: string[] | null;
  targetCloseDate: string | null;
  source: string | null;
  currency: string;
  extractionConfidence: number | null;
  needsReview: boolean;
  reviewReasons: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface DealWithRelations extends Deal {
  company: Company | null;
  assignedUser: Pick<User, 'id' | 'name' | 'avatar' | 'email' | 'title'> | null;
  teamMembers: DealTeamMemberWithUser[];
  documents: Document[];
  activities: Activity[];
  folders: Folder[];
}

// ============================================================
// Team Member Types
// ============================================================

export type TeamMemberRole = 'LEAD' | 'MEMBER' | 'VIEWER';

export interface DealTeamMember {
  id: string;
  dealId: string;
  userId: string;
  role: TeamMemberRole;
  addedAt: string;
}

export interface DealTeamMemberWithUser extends DealTeamMember {
  user: Pick<User, 'id' | 'name' | 'avatar' | 'email' | 'title' | 'department'>;
}

// ============================================================
// Document Types
// ============================================================

export type DocumentType =
  | 'CIM'
  | 'TEASER'
  | 'FINANCIALS'
  | 'LOI'
  | 'DD_REPORT'
  | 'LEGAL'
  | 'OTHER';

export interface Document {
  id: string;
  dealId: string;
  folderId: string | null;
  name: string;
  type: DocumentType;
  fileUrl: string | null;
  fileSize: number | null;
  mimeType: string | null;
  extractedText: string | null;
  aiAnalysis: Record<string, unknown> | null;
  aiSummary: string | null;
  tags: string[] | null;
  extractionStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Activity Types
// ============================================================

export type ActivityType =
  | 'DOCUMENT_UPLOADED'
  | 'STAGE_CHANGED'
  | 'NOTE_ADDED'
  | 'MEETING_SCHEDULED'
  | 'CALL_LOGGED'
  | 'EMAIL_SENT'
  | 'STATUS_UPDATED'
  | 'DEAL_CREATED';

export interface Activity {
  id: string;
  dealId: string;
  userId: string | null;
  type: ActivityType;
  title: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityWithUser extends Activity {
  user: Pick<User, 'id' | 'name' | 'avatar'> | null;
}

// ============================================================
// Folder Types
// ============================================================

export interface Folder {
  id: string;
  dealId: string;
  name: string;
  parentId: string | null;
  fileCount: number;
  isRestricted: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Notification Types
// ============================================================

export type NotificationType =
  | 'DEAL_UPDATE'
  | 'DOCUMENT_UPLOADED'
  | 'MENTION'
  | 'AI_INSIGHT'
  | 'TASK_ASSIGNED'
  | 'COMMENT'
  | 'CONTACT_FOLLOWUP'
  | 'SYSTEM';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string | null;
  dealId: string | null;
  documentId: string | null;
  isRead: boolean;
  createdAt: string;
}

// ============================================================
// Memo Types
// ============================================================

export type MemoType = 'INVESTMENT' | 'SCREENING' | 'IC' | 'CUSTOM';
export type MemoStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'ARCHIVED';

export interface Memo {
  id: string;
  dealId: string;
  userId: string;
  title: string;
  type: MemoType;
  status: MemoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoSection {
  id: string;
  memoId: string;
  title: string;
  content: string | null;
  sortOrder: number;
  isAIGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoWithRelations extends Memo {
  deal: DealWithRelations | null;
  sections: MemoSection[];
  conversations: Conversation[];
}

// ============================================================
// Chat/Conversation Types
// ============================================================

export interface Conversation {
  id: string;
  dealId: string | null;
  memoId: string | null;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  dealId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ChatMessage[];
}

// ============================================================
// AI/OpenAI Types
// ============================================================

export interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ============================================================
// Invitation Types
// ============================================================

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';

export interface Invitation {
  id: string;
  email: string;
  firmName: string;
  role: UserRole;
  token: string;
  status: InvitationStatus;
  invitedBy: string;
  acceptedBy: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Utility Types
// ============================================================

// For Supabase query results
export interface DatabaseError {
  code: string;
  message: string;
  details?: string;
  hint?: string;
}

// For sorted items with timestamps
export interface Timestamped {
  createdAt: string;
}

// Sort helper type
export type SortableByDate = Pick<Timestamped, 'createdAt'>;

// For document relevance scoring
export interface ScoredDocument extends Document {
  relevanceScore: number;
}

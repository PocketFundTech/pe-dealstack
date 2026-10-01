import type { ApiRole } from "@/lib/roles";

// Shared types for the onboarding flow. Ported from *.

export type TaskId = "firm" | "cim" | "team";

export interface TaskDef {
  id: TaskId;
  title: string;
  subtitle: string;
  icon: string;
  time: string;
}

export const TASKS: TaskDef[] = [
  { id: "firm", title: "Define your investment focus", subtitle: "So we can tailor findings to your strategy", icon: "business", time: "30s" },
  { id: "cim", title: "Upload your first deal", subtitle: "A CIM, teaser, or use our sample to try it out", icon: "upload_file", time: "10s" },
  { id: "team", title: "Invite your team", subtitle: "Optional — you can do this later", icon: "group_add", time: "30s" },
];

// Firm task state
export interface FirmData {
  url: string;
  linkedin: string;
  aum: string;
  sectors: string[];
}

export const AUM_OPTIONS = ["<$1M", "$1-10M", "$10-50M", "$50-100M"];

export const DEFAULT_SECTORS = [
  "Healthcare",
  "Industrials",
  "Software",
  "Consumer",
  "Financial",
  "Tech-enabled services",
  "Energy",
];

export interface TeamInvite {
  email: string;
  role: ApiRole;
}

// API response shape — matches DEFAULT_STATUS in
// apps/api/src/routes/onboarding.ts exactly. Fields I previously
// invented (`onboardingCompleted`, `onboardingSkipped`) are not
// returned by GET /onboarding/status.
export interface OnboardingStatus {
  welcomeShown?: boolean;
  checklistDismissed?: boolean;
  steps?: Record<string, boolean>;
  context?: OnboardingContext | null;
}

// Who is onboarding — from GET /onboarding/status. Invited teammates skip the
// firm-profile task (the org already has one / it's the admin's to set).
export interface OnboardingContext {
  invited?: boolean;
  isAdmin?: boolean;
  isFounder?: boolean;
  firmProfileSet?: boolean;
  canEditFirmProfile?: boolean;
}

/** Tasks to show: invited teammates get the shortened (no firm task) list. */
export function visibleTasks(context: OnboardingContext | null | undefined): TaskDef[] {
  if (context && (context.invited || context.canEditFirmProfile === false)) {
    return TASKS.filter((t) => t.id !== "firm");
  }
  return TASKS;
}

// Legacy step IDs stored on the backend ↔ current 3-task flow.
// Matches the mapping in onboarding-flow.js.
export const TASK_TO_LEGACY_STEP: Record<TaskId, string> = {
  firm: "createDeal",
  cim: "uploadDocument",
  team: "inviteTeamMember",
};

export const LEGACY_STEP_TO_TASK: Record<string, TaskId> = {
  createDeal: "firm",
  uploadDocument: "cim",
  inviteTeamMember: "team",
};

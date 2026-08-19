// Shared activity-log formatters. Ported from
// activity-formatters.js — used by RecentActivityWidget
// today, and ready for future Team Activity admin views.
//
// The legacy module exposed string-HTML helpers; this version returns
// structured data so React can render entity names as styled spans without
// dangerouslySetInnerHTML.

export type AuditLog = {
  id: string;
  action: string;
  description?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  entityName?: string | null;
  resourceName?: string | null;
  resourceType?: string | null;
  createdAt: string;
};

export type FormattedAction = {
  /** Plain prefix shown before the entity span. */
  prefix: string;
  /** Entity name to highlight in primary color. May be empty. */
  entity: string;
  /** Plain suffix shown after the entity span. */
  suffix: string;
  /** Material Symbols icon name. */
  icon: string;
};

type ActionDef = {
  before: string;
  after?: string;
  icon: string;
};

// Mirrors actionMap in activity-formatters.js. The before
// segment is rendered before the entity name; if `after` is present, it's
// rendered after the entity. When both are blank, the action is treated as
// entity-less (LOGIN, LOGOUT, SETTINGS_CHANGED).
const ACTION_MAP: Record<string, ActionDef> = {
  DEAL_CREATED:        { before: "created deal ",     icon: "add_circle" },
  DEAL_UPDATED:        { before: "updated ",          icon: "edit" },
  DEAL_DELETED:        { before: "deleted deal ",     icon: "delete" },
  DEAL_STAGE_CHANGED:  { before: "moved ",            after: " to a new stage", icon: "arrow_forward" },
  DEAL_ASSIGNED:       { before: "assigned ",         icon: "person_add" },
  DEAL_VIEWED:         { before: "viewed ",           icon: "visibility" },
  DEAL_EXPORTED:       { before: "exported ",         icon: "file_download" },
  DOCUMENT_UPLOADED:   { before: "uploaded ",         icon: "upload_file" },
  DOCUMENT_DELETED:    { before: "deleted document ", icon: "delete" },
  DOCUMENT_DOWNLOADED: { before: "downloaded ",       icon: "download" },
  DOCUMENT_VIEWED:     { before: "viewed document ",  icon: "visibility" },
  MEMO_CREATED:        { before: "created memo ",     icon: "description" },
  MEMO_UPDATED:        { before: "updated memo ",     icon: "edit_note" },
  MEMO_EXPORTED:       { before: "exported memo ",    icon: "file_download" },
  USER_CREATED:        { before: "added team member ", icon: "person_add" },
  USER_UPDATED:        { before: "updated user ",     icon: "manage_accounts" },
  USER_INVITED:        { before: "invited ",          icon: "mail" },
  INVITATION_SENT:     { before: "sent invitation to ", icon: "send" },
  INVITATION_ACCEPTED: { before: "",                  after: " accepted invitation", icon: "how_to_reg" },
  AI_INGEST:           { before: "ingested document ", icon: "auto_awesome" },
  AI_GENERATE:         { before: "generated analysis for ", icon: "auto_awesome" },
  AI_CHAT:             { before: "chatted with ",     icon: "auto_awesome" },
  LOGIN:               { before: "logged in",         icon: "login" },
  LOGOUT:              { before: "logged out",        icon: "logout" },
  SETTINGS_CHANGED:    { before: "updated settings",  icon: "settings" },
};

export function formatAuditAction(log: AuditLog): FormattedAction {
  const entity = log.entityName || log.resourceName || "";
  const def = ACTION_MAP[log.action];
  if (def) {
    return {
      prefix: def.before,
      entity,
      suffix: def.after ?? "",
      icon: def.icon,
    };
  }
  // Fallback matches legacy renderActivityItem: it preserves the raw action
  // string (e.g. "performed LOGIN_FAILED") rather than lower-casing.
  return {
    prefix: `performed ${log.action || "an action"}`,
    entity: "",
    suffix: "",
    icon: "info",
  };
}

export function isAIAction(log: AuditLog): boolean {
  return Boolean(log.action?.startsWith("AI_"));
}

export function getActorName(log: AuditLog): string {
  if (isAIAction(log)) return "Avise AI";
  return log.userName || log.userEmail?.split("@")[0] || "System";
}

/**
 * Group logs into Today / Yesterday / "Mon D" buckets, preserving input order.
 * Mirrors groupLogsByDay in the legacy formatter.
 */
export function groupLogsByDay(logs: AuditLog[]): Array<{ label: string; logs: AuditLog[] }> {
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getTime() - 86_400_000).toDateString();

  const groups = new Map<string, AuditLog[]>();
  for (const log of logs) {
    const d = new Date(log.createdAt);
    const ds = d.toDateString();
    let label: string;
    if (ds === today) label = "Today";
    else if (ds === yesterday) label = "Yesterday";
    else label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const arr = groups.get(label) || [];
    arr.push(log);
    groups.set(label, arr);
  }
  return [...groups.entries()].map(([label, logs]) => ({ label, logs }));
}

export type NavItem = {
  id: string;
  label: string;
  icon: string;
  href: string;
  adminOnly?: boolean;
  memberOnly?: boolean;
  isAI?: boolean;
  divider?: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", href: "/dashboard" },
  { id: "deals", label: "Deals", icon: "work", href: "/deals" },
  { id: "data-room", label: "Data Room", icon: "folder_open", href: "/data-room" },
  { id: "nda", label: "NDAs", icon: "gavel", href: "/nda" },
  { id: "crm", label: "CRM", icon: "groups", href: "/contacts", memberOnly: true },
  { id: "admin", label: "Admin", icon: "admin_panel_settings", href: "/admin", adminOnly: true },
  { id: "divider", label: "", icon: "", href: "", divider: true },
  { id: "ai-reports", label: "AI Reports", icon: "auto_awesome", href: "/memo-builder", isAI: true, memberOnly: true },
];

export const STAGES = [
  "INITIAL_REVIEW",
  "DUE_DILIGENCE",
  "IOI_SUBMITTED",
  "LOI_SUBMITTED",
  "NEGOTIATION",
  "CLOSING",
  "PASSED",
  "CLOSED_WON",
  "CLOSED_LOST",
] as const;

export const KANBAN_STAGES = [
  "INITIAL_REVIEW",
  "DUE_DILIGENCE",
  "IOI_SUBMITTED",
  "LOI_SUBMITTED",
  "NEGOTIATION",
  "CLOSING",
] as const;

export const STAGE_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  INITIAL_REVIEW: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-200" },
  DUE_DILIGENCE: { bg: "bg-indigo-50", text: "text-indigo-700", border: "border-indigo-200" },
  IOI_SUBMITTED: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" },
  LOI_SUBMITTED: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-200" },
  NEGOTIATION: { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-200" },
  CLOSING: { bg: "bg-teal-50", text: "text-teal-700", border: "border-teal-200" },
  PASSED: { bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-300" },
  CLOSED_WON: { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" },
  CLOSED_LOST: { bg: "bg-red-50", text: "text-red-700", border: "border-red-200" },
};

export const STAGE_LABELS: Record<string, string> = {
  INITIAL_REVIEW: "Initial Review",
  DUE_DILIGENCE: "Due Diligence",
  IOI_SUBMITTED: "IOI Submitted",
  LOI_SUBMITTED: "LOI Submitted",
  NEGOTIATION: "Negotiation",
  CLOSING: "Closing",
  PASSED: "Passed",
  CLOSED_WON: "Closed Won",
  CLOSED_LOST: "Closed Lost",
};

export const SORT_OPTIONS = [
  { label: "Recent Activity", sortBy: "updatedAt", sortOrder: "desc" },
  { label: "Newest First", sortBy: "createdAt", sortOrder: "desc" },
  { label: "Oldest First", sortBy: "createdAt", sortOrder: "asc" },
  { label: "Deal Size (High)", sortBy: "dealSize", sortOrder: "desc" },
  { label: "Deal Size (Low)", sortBy: "dealSize", sortOrder: "asc" },
  { label: "IRR (High)", sortBy: "irrProjected", sortOrder: "desc" },
  { label: "Revenue (High)", sortBy: "revenue", sortOrder: "desc" },
  { label: "Priority", sortBy: "priority", sortOrder: "desc" },
  { label: "Name A-Z", sortBy: "name", sortOrder: "asc" },
] as const;

export const DEAL_SIZE_OPTIONS = [
  { label: "All Sizes", min: "", max: "" },
  { label: "Under $10M", min: "", max: "10" },
  { label: "$10M - $50M", min: "10", max: "50" },
  { label: "$50M - $100M", min: "50", max: "100" },
  { label: "Over $100M", min: "100", max: "" },
] as const;

export const PRIORITY_OPTIONS = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;

export const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

// ---------------------------------------------------------------------------
// Deal Card Metrics -- maps metric keys to display info.
// Port of METRIC_CONFIG from crm.js
// ---------------------------------------------------------------------------
export type MetricKey = "irrProjected" | "mom" | "ebitda" | "revenue" | "dealSize";

export interface MetricConfig {
  label: string;
  kanbanLabel: string;
}

export const METRIC_CONFIG: Record<MetricKey, MetricConfig> = {
  irrProjected: { label: "IRR (Proj)", kanbanLabel: "IRR" },
  mom: { label: "MoM", kanbanLabel: "MoM" },
  ebitda: { label: "EBITDA", kanbanLabel: "EBITDA" },
  revenue: { label: "Revenue", kanbanLabel: "Revenue" },
  dealSize: { label: "Deal Size", kanbanLabel: "Size" },
};

export const DEFAULT_CARD_METRICS: MetricKey[] = ["irrProjected", "mom", "ebitda", "revenue"];

export const ALL_METRIC_KEYS: MetricKey[] = ["irrProjected", "mom", "ebitda", "revenue", "dealSize"];

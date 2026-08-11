// Single source of truth for browser-storage keys.
//
// Convention: all keys are prefixed with `pe-` to match what apps/web already
// uses (e.g. `pe-sidebar-collapsed`). Don't introduce new prefixes without
// migrating the legacy app too — a shared convention lets users keep their
// preferences across both codebases during the migration window.

export const STORAGE_KEYS = {
  userCache: "pe-user-cache",
  sidebarCollapsed: "pe-sidebar-collapsed",
  dealsView: "pe-deals-view",
  dealCardMetrics: "pe-deal-card-metrics",
  aiAssistantHistory: "pe-ai-assistant-history",
  customGraphs: "pe-custom-graphs",
  contactsStaleDismissed: "pe-contacts-stale-dismissed",
  // Last Inbox Deal Finder scan result, kept so the found candidates survive
  // closing the review modal, remounting the dashboard, and navigation — rather
  // than forcing a slow re-scan to see them again.
  inboxScanResult: "pe-inbox-scan-result",
} as const;

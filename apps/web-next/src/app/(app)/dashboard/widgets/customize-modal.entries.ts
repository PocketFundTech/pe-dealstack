// Configuration tables + entry-list builder for the CustomizeDashboardModal.
// Extracted from customize-modal.tsx so the parent module stays under the
// 500-line cap.

import { WIDGETS, WidgetId, CoreWidgetId, CORE_WIDGETS } from "./registry";

// ---------------------------------------------------------------------------
// Category configuration — matches dashboard-widgets.js CATEGORY_LABELS
// ---------------------------------------------------------------------------
export const CATEGORY_LABELS: Record<string, { name: string; icon: string }> = {
  core:         { name: "Core Widgets", icon: "dashboard" },
  ai:           { name: "AI-Powered", icon: "auto_awesome" },
  productivity: { name: "Productivity", icon: "task_alt" },
  deals:        { name: "Deal Flow & Pipeline", icon: "work" },
  portfolio:    { name: "Portfolio & Fund", icon: "account_balance" },
  market:       { name: "Market & Research", icon: "insights" },
  team:         { name: "Team & Contacts", icon: "groups" },
  documents:    { name: "Documents & Alerts", icon: "folder" },
};

// Map each optional widget id to a category (mirrors dashboard-widgets.js WIDGET_CONFIG)
export const WIDGET_CATEGORY: Record<WidgetId, string> = {
  "quick-actions":      "productivity",
  "quick-notes":        "productivity",
  "upcoming-deadlines": "productivity",
  "calendar":           "productivity",
  "deal-funnel":        "deals",
  "recent-activity":    "deals",
  "watchlist":          "deals",
  "key-contacts":       "team",
  "team-performance":   "team",
  "document-alerts":    "documents",
  "market-multiples":   "market",
  "portfolio-signals":  "portfolio",
};

// Core widgets that are not "coming soon" have CoreWidgetId; "market-sentiment"
// is a special entry in CORE_WIDGETS that has no CoreWidgetId counterpart.
export type CoreOrComingSoonId = CoreWidgetId | "market-sentiment";

export const CATEGORY_ORDER = ["core", "ai", "productivity", "deals", "portfolio", "market", "team", "documents"];

// ---------------------------------------------------------------------------
// Unified entry type covering both core and optional widgets in the modal
// ---------------------------------------------------------------------------
export interface ModalEntry {
  id: string;
  title: string;
  description: string;
  icon: string;
  category: string;
  isCore: boolean;
  comingSoon?: boolean;
}

// Build the full list of entries the modal should show, in legacy order.
function buildModalEntries(): ModalEntry[] {
  const entries: ModalEntry[] = [];

  // Core widgets (stats-cards through ai-deal-signals + market-sentiment)
  CORE_WIDGETS.forEach((w) => {
    // ai-deal-signals and market-sentiment go into "ai" category;
    // everything else is "core".
    const isAi = w.id === "ai-deal-signals" || w.id === "market-sentiment";
    entries.push({
      id: w.id,
      title: w.title,
      description: w.description,
      icon: w.icon,
      category: isAi ? "ai" : "core",
      isCore: true,
      comingSoon: w.comingSoon,
    });
  });

  // Optional sidebar widgets
  WIDGETS.forEach((w) => {
    entries.push({
      id: w.id,
      title: w.title,
      description: w.description,
      icon: w.icon,
      category: WIDGET_CATEGORY[w.id] || "productivity",
      isCore: false,
    });
  });

  return entries;
}

export const ALL_ENTRIES = buildModalEntries();

// ---------------------------------------------------------------------------
// Draft state holds both core and optional visibility as string sets so we
// can handle them uniformly in the UI.
// ---------------------------------------------------------------------------
export interface DraftState {
  core: Set<CoreOrComingSoonId>;
  optional: Set<WidgetId>;
  /** Ordered list of reorderable core IDs (excludes coming-soon entries) */
  coreOrder: CoreWidgetId[];
}

// The reorderable core categories — entries in these categories can be dragged
// to change their display position on the dashboard.
export const REORDERABLE_CATEGORIES = new Set(["core", "ai"]);

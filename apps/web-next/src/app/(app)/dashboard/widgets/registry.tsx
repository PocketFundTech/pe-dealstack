"use client";

import { ComponentType } from "react";
import { QuickActionsWidget } from "./quick-actions";
import { QuickNotesWidget } from "./quick-notes";
import { DealFunnelWidget } from "./deal-funnel";
import { UpcomingDeadlinesWidget } from "./upcoming-deadlines";
import { MarketMultiplesWidget } from "./market-multiples";
import { CalendarWidget } from "./calendar";
import { KeyContactsWidget } from "./key-contacts";
import { RecentActivityWidget } from "./recent-activity";
import { TeamPerformanceWidget } from "./team-performance";
import { DocumentAlertsWidget } from "./document-alerts";
import { WatchlistWidget } from "./watchlist";
import { PortfolioSignalsWidget } from "../dashboard-widgets";

// ---------------------------------------------------------------------------
// Core widget IDs — rendered inline in page.tsx, not via the optional grid.
// Visibility is persisted separately from optional widgets.
// ---------------------------------------------------------------------------
export type CoreWidgetId =
  | "stats-cards"
  | "active-priorities"
  | "my-tasks"
  | "portfolio-allocation"
  | "ai-deal-signals";

// Optional sidebar widget IDs — rendered via the DraggableWidget grid.
export type WidgetId =
  | "quick-actions"
  | "quick-notes"
  | "deal-funnel"
  | "upcoming-deadlines"
  | "market-multiples"
  | "calendar"
  | "key-contacts"
  | "recent-activity"
  | "team-performance"
  | "document-alerts"
  | "watchlist"
  | "portfolio-signals";

export interface WidgetMeta {
  id: WidgetId;
  title: string;
  description: string;
  icon: string;
  Component: ComponentType;
}

// ---------------------------------------------------------------------------
// Core widget metadata — used only by the Customize Dashboard modal.
// "Coming Soon" entries have comingSoon: true and no Component.
// ---------------------------------------------------------------------------
export interface CoreWidgetMeta {
  id: CoreWidgetId | "market-sentiment";
  title: string;
  description: string;
  icon: string;
  comingSoon?: boolean;
}

export const CORE_WIDGETS: CoreWidgetMeta[] = [
  {
    id: "stats-cards",
    title: "Pipeline Stats",
    description: "Overview of deals across pipeline stages.",
    icon: "analytics",
  },
  {
    id: "active-priorities",
    title: "Active Priorities",
    description: "Table of high-priority deals requiring immediate attention.",
    icon: "priority_high",
  },
  {
    id: "my-tasks",
    title: "My Tasks",
    description: "Your pending tasks and to-dos.",
    icon: "check_circle",
  },
  {
    id: "portfolio-allocation",
    title: "Portfolio Allocation",
    description: "Sector allocation breakdown chart.",
    icon: "pie_chart",
  },
  {
    id: "ai-deal-signals",
    title: "Inbox Deal Finder",
    description: "Scan your Gmail inbox for new deal candidates with AI.",
    icon: "radar",
  },
  {
    id: "market-sentiment",
    title: "Market Sentiment",
    description: "AI-powered market analysis and sentiment index.",
    icon: "psychology",
    comingSoon: true,
  },
];

// Order here is the default display order when a widget is enabled.
export const WIDGETS: WidgetMeta[] = [
  {
    id: "quick-actions",
    title: "Quick Actions",
    description: "Shortcuts to New Deal, Upload Doc, Add Contact.",
    icon: "bolt",
    Component: QuickActionsWidget,
  },
  {
    id: "quick-notes",
    title: "Quick Notes",
    description: "Personal scratchpad. Saves to this browser only.",
    icon: "sticky_note_2",
    Component: QuickNotesWidget,
  },
  {
    id: "deal-funnel",
    title: "Deal Funnel",
    description: "Active deals grouped by pipeline stage.",
    icon: "filter_alt",
    Component: DealFunnelWidget,
  },
  {
    id: "upcoming-deadlines",
    title: "Upcoming Deadlines",
    description: "Tasks due in the next 14 days, color-coded by urgency.",
    icon: "event_upcoming",
    Component: UpcomingDeadlinesWidget,
  },
  {
    id: "calendar",
    title: "This Week",
    description: "Tasks + deal close dates for the next 7 days.",
    icon: "calendar_month",
    Component: CalendarWidget,
  },
  {
    id: "key-contacts",
    title: "Key Contacts",
    description: "Top 5 contacts by relationship score.",
    icon: "contacts",
    Component: KeyContactsWidget,
  },
  {
    id: "recent-activity",
    title: "Recent Activity",
    description: "Latest audit events across your org.",
    icon: "history",
    Component: RecentActivityWidget,
  },
  {
    id: "team-performance",
    title: "Team Performance",
    description: "Active deals + open tasks + capacity per teammate.",
    icon: "groups",
    Component: TeamPerformanceWidget,
  },
  {
    id: "document-alerts",
    title: "Document Alerts",
    description: "Documents awaiting review or AI analysis.",
    icon: "report",
    Component: DocumentAlertsWidget,
  },
  {
    id: "watchlist",
    title: "Watchlist",
    description: "Companies you're tracking outside the pipeline.",
    icon: "visibility",
    Component: WatchlistWidget,
  },
  {
    id: "market-multiples",
    title: "Market Multiples",
    description: "Static EV/EBITDA + EV/Revenue reference table.",
    icon: "insert_chart",
    Component: MarketMultiplesWidget,
  },
  {
    id: "portfolio-signals",
    title: "Portfolio Signal Monitor",
    description: "Scan active deals for AI-detected signals (leadership, financial, market shifts).",
    icon: "radar",
    Component: PortfolioSignalsWidget,
  },
];

export const DEFAULT_VISIBLE: WidgetId[] = ["quick-actions", "deal-funnel", "upcoming-deadlines"];

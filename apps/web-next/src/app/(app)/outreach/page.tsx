"use client";

import Link from "next/link";
import { useUser } from "@/providers/UserProvider";
import { CICERO_CAPITAL_ORG_SLUG } from "@/lib/constants";

// The 6-stage outreach-automation pipeline this tab will eventually power.
// No integrations exist yet (Reply.io / Clay / Apollo / WhatsApp) -- this
// page is a placeholder that previews the roadmap for Cicero Capital.
const PIPELINE_STAGES: Array<{ icon: string; title: string; description: string }> = [
  {
    icon: "travel_explore",
    title: "Source",
    description: "Identify target contacts and companies that match the firm's outreach criteria.",
  },
  {
    icon: "auto_awesome",
    title: "Enrich",
    description: "Augment sourced contacts with firmographic and contact-level data.",
  },
  {
    icon: "send",
    title: "Send",
    description: "Deliver personalized outreach sequences across email and messaging channels.",
  },
  {
    icon: "forum",
    title: "Handle Reply",
    description: "Classify and route incoming replies automatically.",
  },
  {
    icon: "priority_high",
    title: "Escalate",
    description: "Flag high-intent responses for a team member to take over.",
  },
  {
    icon: "event_available",
    title: "Meeting Booked",
    description: "Confirm the meeting and hand the deal off to the team.",
  },
];

export default function OutreachPage() {
  const { user, loading } = useUser();

  // Re-check access here rather than trusting the sidebar to have hidden the
  // link -- the sidebar filter is a UX convenience, not an access boundary.
  const isCiceroCapital = user?.organization?.slug === CICERO_CAPITAL_ORG_SLUG;

  if (loading) {
    return (
      <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex items-center justify-center py-20">
        <div className="text-center text-text-muted">
          <span className="material-symbols-outlined text-4xl animate-spin">progress_activity</span>
          <p className="mt-2 text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isCiceroCapital) {
    return (
      <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex items-center justify-center py-20">
        <div className="text-center">
          <span className="material-symbols-outlined text-5xl text-red-400">lock</span>
          <h2 className="mt-3 text-lg font-bold text-text-main">Access Denied</h2>
          <p className="text-sm text-text-muted mt-1">
            You do not have permission to view Outreach.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 mx-auto max-w-[1600px] w-full flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-main tracking-tight font-display">Outreach</h1>
          <p className="text-text-secondary text-sm mt-1">
            Automated outreach for sourcing and engaging deal opportunities.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary-light text-primary rounded-full text-sm font-medium">
          <span className="material-symbols-outlined text-[18px]">schedule</span>
          <span>In Development</span>
        </div>
      </div>

      {/* Roadmap intro */}
      <div className="rounded-lg border border-border-subtle bg-surface-card p-5 shadow-card">
        <div className="flex items-start gap-3">
          <span className="material-symbols-outlined text-primary text-[22px]">campaign</span>
          <div>
            <h2 className="text-sm font-bold text-text-main">Coming soon</h2>
            <p className="text-sm text-text-secondary mt-1">
              Outreach automation is not yet available. Once live, it will run deal sourcing and
              engagement through the six-stage pipeline below -- no setup is required from you
              until then.
            </p>
          </div>
        </div>
      </div>

      {/* 6-stage pipeline preview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {PIPELINE_STAGES.map((stage, i) => (
          <div
            key={stage.title}
            className="relative flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-card p-5 shadow-card"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-text-muted">{`0${i + 1}`}</span>
                <span className="material-symbols-outlined text-primary text-[20px]">
                  {stage.icon}
                </span>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted bg-background-body px-2 py-1 rounded-full border border-border-subtle">
                Planned
              </span>
            </div>
            <h3 className="text-sm font-bold text-text-main mt-1">{stage.title}</h3>
            <p className="text-xs text-text-muted">{stage.description}</p>
          </div>
        ))}
      </div>

      {/* Back link */}
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}

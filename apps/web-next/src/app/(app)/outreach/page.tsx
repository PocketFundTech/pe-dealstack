"use client";

import { useUser } from "@/providers/UserProvider";
import { OUTREACH_ALLOWED_ORG_SLUGS } from "@/lib/constants";
import { OutreachBoard } from "@/components/outreach/OutreachBoard";

export default function OutreachPage() {
  const { user, loading } = useUser();

  // Re-check access here rather than trusting the sidebar to have hidden the
  // link -- the sidebar filter is a UX convenience, not an access boundary.
  const isCiceroCapital = OUTREACH_ALLOWED_ORG_SLUGS.includes(user?.organization?.slug ?? "");

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
            Track proprietary and broker-sourced contacts through the sourcing pipeline.
          </p>
        </div>
      </div>

      <OutreachBoard />
    </div>
  );
}

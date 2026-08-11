"use client";

import { formatRelativeTime } from "@/lib/formatters";
import { IntegrationActivityFeed } from "@/components/integrations/IntegrationActivityFeed";
import type { Activity } from "./deal-detail-shared";

// ---------------------------------------------------------------------------
// Activity Tab
// ---------------------------------------------------------------------------

export function ActivityTab({
  activities,
  loading,
  dealId,
}: {
  activities: Activity[];
  loading: boolean;
  dealId?: string;
}) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-bold text-text-secondary uppercase tracking-wider mb-3">
          Synced from your tools
        </h3>
        <IntegrationActivityFeed dealId={dealId} />
      </section>

      <section>
        <h3 className="text-sm font-bold text-text-secondary uppercase tracking-wider mb-3">
          CRM activity
        </h3>
        {loading ? (
          <div className="text-center py-12 text-text-muted">
            <span className="material-symbols-outlined text-3xl animate-spin">progress_activity</span>
            <p className="mt-2 text-sm">Loading activity...</p>
          </div>
        ) : activities.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-border-subtle rounded-lg">
            <span className="material-symbols-outlined text-3xl text-text-muted">history</span>
            <p className="mt-2 text-sm text-text-muted">No activity recorded yet</p>
          </div>
        ) : (
          <div
            className="rounded-xl p-5"
            style={{
              background: "rgba(255, 255, 255, 0.8)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(229, 231, 235, 0.8)",
              boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
            }}
          >
            <div className="relative">
              <div className="absolute left-[11px] top-2 bottom-2 w-0.5 bg-border-subtle" />
              <div className="space-y-5">
                {activities.map((activity) => (
                  <div key={activity.id} className="flex gap-4 relative">
                    <div className="size-6 rounded-full bg-blue-100 border-2 border-white z-10 shrink-0 flex items-center justify-center shadow-sm">
                      <span className="material-symbols-outlined text-[12px] text-primary">circle</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-main">
                        {activity.userName && (
                          <span className="font-semibold">{activity.userName} </span>
                        )}
                        {activity.description || activity.action}
                      </p>
                      <p className="text-xs text-text-muted mt-0.5">
                        {formatRelativeTime(activity.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

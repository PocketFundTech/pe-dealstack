// Client component on purpose: this fallback renders <Skeleton.Line/> /
// <Skeleton.Circle/>, whose sub-components are static members attached to the
// Skeleton client component via Object.assign. Static members are NOT reachable
// across the server->client reference boundary — as a Server Component this
// file would see `Skeleton.Line` as undefined and throw React error #130
// ("element type is invalid: got undefined") on load (loading.tsx is the
// Suspense fallback, so it only renders during load). "use client" keeps
// Skeleton in the client graph so the compound access resolves.
"use client";

import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Route-level skeleton shown while the dashboard navigates / loads. A
 * layout-shaped placeholder (greeting + stat cards + widgets) reads as
 * "content is coming" rather than the generic centered spinner.
 */
export default function DashboardLoading() {
  return (
    <div className="p-6 md:p-8">
      {/* Greeting header */}
      <div className="mb-8 space-y-2">
        <Skeleton.Line width={260} height={26} />
        <Skeleton.Line width={180} height={14} />
      </div>

      {/* Stat cards row */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm"
          >
            <Skeleton.Line width="50%" height={12} className="mb-4" />
            <Skeleton.Line width="70%" height={28} />
          </div>
        ))}
      </div>

      {/* Widget panels */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm lg:col-span-2">
          <Skeleton.Line width={160} height={18} className="mb-6" />
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton.Circle size={36} />
                <div className="flex-1 space-y-2">
                  <Skeleton.Line width="40%" height={13} />
                  <Skeleton.Line width="65%" height={11} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
          <Skeleton.Line width={120} height={18} className="mb-6" />
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={48} rounded="lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

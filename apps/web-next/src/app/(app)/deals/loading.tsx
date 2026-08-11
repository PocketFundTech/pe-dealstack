// Client component on purpose: renders compound <Skeleton.Line/> etc., whose
// static members (attached via Object.assign) don't survive the server->client
// reference boundary. As a Server Component this fallback would read
// `Skeleton.Line` as undefined and throw React error #130 on load. See
// dashboard/loading.tsx for the full explanation.
"use client";

import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Route-level skeleton for the deals list/pipeline while it navigates / loads.
 * Header + filter bar + table rows mirror the real layout so the transition
 * reads as content arriving rather than a blank spinner.
 */
export default function DealsLoading() {
  return (
    <div className="p-6 md:p-8">
      {/* Header: title + actions */}
      <div className="mb-6 flex items-center justify-between">
        <Skeleton.Line width={200} height={24} />
        <div className="flex gap-3">
          <Skeleton width={120} height={38} rounded="lg" />
          <Skeleton width={120} height={38} rounded="lg" />
        </div>
      </div>

      {/* Filter bar */}
      <div className="mb-6 flex flex-wrap gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width={130} height={34} rounded="lg" />
        ))}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm">
        <div className="border-b border-gray-100 bg-gray-50 px-5 py-3">
          <Skeleton.Line width="30%" height={12} />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-gray-50 px-5 py-4 last:border-0"
          >
            <Skeleton.Circle size={32} />
            <Skeleton.Line width="22%" height={14} />
            <Skeleton.Line width="14%" height={14} />
            <Skeleton.Badge />
            <div className="ml-auto">
              <Skeleton.Line width={80} height={14} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

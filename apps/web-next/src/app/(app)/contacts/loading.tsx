// Client component on purpose: renders compound <Skeleton.Line/> etc., whose
// static members (attached via Object.assign) don't survive the server->client
// reference boundary. As a Server Component this fallback would read
// `Skeleton.Line` as undefined and throw React error #130 on load. See
// dashboard/loading.tsx for the full explanation.
"use client";

import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Route-level skeleton for the contacts page while it navigates / loads.
 * Header + a grid of contact-card placeholders mirror the real layout.
 */
export default function ContactsLoading() {
  return (
    <div className="p-6 md:p-8">
      {/* Header: title + actions */}
      <div className="mb-6 flex items-center justify-between">
        <Skeleton.Line width={180} height={24} />
        <div className="flex gap-3">
          <Skeleton width={140} height={38} rounded="lg" />
          <Skeleton width={120} height={38} rounded="lg" />
        </div>
      </div>

      {/* Contact card grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm"
          >
            <div className="mb-4 flex items-center gap-3">
              <Skeleton.Circle size={44} />
              <div className="flex-1 space-y-2">
                <Skeleton.Line width="60%" height={15} />
                <Skeleton.Line width="40%" height={12} />
              </div>
              <Skeleton.Badge />
            </div>
            <div className="space-y-2">
              <Skeleton.Line width="85%" height={12} />
              <Skeleton.Line width="55%" height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

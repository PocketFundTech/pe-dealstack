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
import "@/components/dash/dash.css";

/**
 * Route-level skeleton shown while the dashboard navigates / loads. A
 * layout-shaped placeholder (masthead + brief column + right rail) reads as
 * "content is coming" rather than the generic centered spinner.
 */
export default function DashboardLoading() {
  const panel = "dash-panel overflow-hidden";
  return (
    <div className="dash px-4 py-6 md:px-8 md:py-9 lg:px-10">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-7">
        {/* Masthead */}
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-col gap-2.5">
              <Skeleton.Line width={170} height={10} />
              <Skeleton.Line width={300} height={30} />
              <Skeleton.Line width={340} height={14} />
            </div>
            <div className="flex gap-2">
              <Skeleton width={110} height={36} rounded="md" />
              <Skeleton width={112} height={36} rounded="md" />
            </div>
          </div>
          <div className="dash-double-rule" />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
          <div className="flex flex-col gap-6">
            {/* Today */}
            <div className={panel}>
              <div className="px-6 pt-5 pb-3.5"><Skeleton.Line width={80} height={18} /></div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 border-t border-(--dash-rule) px-6 py-3.5">
                  <Skeleton width={92} height={18} rounded="sm" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton.Line width={`${60 - i * 12}%`} height={13} />
                    <Skeleton.Line width="35%" height={11} />
                  </div>
                  <Skeleton width={64} height={26} rounded="md" />
                </div>
              ))}
            </div>
            {/* Pipeline */}
            <div className={panel}>
              <div className="px-6 pt-5 pb-1"><Skeleton.Line width={90} height={18} /></div>
              <div className="grid grid-cols-1 sm:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex flex-col gap-2.5 px-6 pt-4 pb-5">
                    <Skeleton.Line width={70} height={10} />
                    <Skeleton width={40} height={34} />
                    <Skeleton width="100%" height={4} rounded="full" />
                  </div>
                ))}
              </div>
            </div>
            {/* Priorities */}
            <div className={panel}>
              <div className="px-6 pt-5 pb-4"><Skeleton.Line width={150} height={18} /></div>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-6 border-t border-(--dash-rule) px-6 py-3.5">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton.Line width="45%" height={13} />
                    <Skeleton.Line width="25%" height={11} />
                  </div>
                  <Skeleton.Line width={90} height={12} />
                  <Skeleton.Circle size={26} />
                  <Skeleton.Line width={60} height={13} />
                </div>
              ))}
            </div>
          </div>

          {/* Rail */}
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-1">
            {[5, 4].map((rows, p) => (
              <div key={p} className={panel}>
                <div className="border-b border-(--dash-rule) px-5 pt-4 pb-3"><Skeleton.Line width={110} height={16} /></div>
                <div className="flex flex-col gap-3.5 px-5 py-4">
                  {Array.from({ length: rows }).map((_, i) => (
                    <Skeleton.Line key={i} width={`${85 - i * 9}%`} height={12} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

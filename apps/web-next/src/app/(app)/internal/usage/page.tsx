"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useUser } from "@/providers/UserProvider";
import { cn } from "@/lib/cn";
import { LiveFeed } from "./LiveFeed";
import { Leaderboard } from "./Leaderboard";

// CostBreakdown renders chart.js — only shown on its own tab, so load it
// lazily to keep chart.js out of this admin page's initial bundle.
const CostBreakdown = dynamic(
  () => import("./CostBreakdown").then((m) => m.CostBreakdown),
  { ssr: false },
);

type Tab = "feed" | "leaderboard" | "breakdown";

const TABS: { id: Tab; label: string }[] = [
  { id: "feed",        label: "Live Feed"       },
  { id: "leaderboard", label: "User Leaderboard" },
  { id: "breakdown",   label: "Cost Breakdown"   },
];

export default function InternalUsagePage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("feed");

  useEffect(() => {
    if (!loading && user && !user.isInternal) {
      router.replace("/dashboard");
    }
  }, [user, loading, router]);

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading…</div>;
  }

  if (!user?.isInternal) {
    return null;
  }

  return (
    <div className="min-h-full bg-[#F8F9FA]">
      {/* ── Page header ── */}
      <div className="px-8 pt-8 pb-0">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "#003366" }}
        >
          AI Usage
        </h1>
        <p className="text-xs text-gray-400 mt-1 tracking-wide uppercase">
          Cross-org telemetry · admin only
        </p>

        {/* ── Pill-group tab strip ── */}
        <div className="flex gap-1.5 mt-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                tab === t.id
                  ? "text-white"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200/60",
              )}
              style={
                tab === t.id
                  ? { backgroundColor: "#003366" }
                  : undefined
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Divider between tabs and content */}
      <div className="border-b border-gray-200 mt-3" />

      {/* ── Tab content ── */}
      <div className="px-8 py-6">
        {tab === "feed"        && <LiveFeed />}
        {tab === "leaderboard" && <Leaderboard />}
        {tab === "breakdown"   && <CostBreakdown />}
      </div>
    </div>
  );
}

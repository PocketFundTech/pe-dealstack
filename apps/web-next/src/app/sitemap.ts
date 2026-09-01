import type { MetadataRoute } from "next";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://lmmos.ai";

// Public marketing pages only. /solutions, /company, and /resources are
// deliberately excluded — they're "coming soon" placeholders marked
// noindex (see their metadata) until real content ships; listing a
// noindexed URL in the sitemap sends Google a contradictory signal.
export default function sitemap(): MetadataRoute.Sitemap {
  const routes: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
    { path: "", priority: 1, changeFrequency: "weekly" },
    { path: "/pricing", priority: 0.8, changeFrequency: "monthly" },
    { path: "/security", priority: 0.6, changeFrequency: "monthly" },
    { path: "/documentation", priority: 0.6, changeFrequency: "monthly" },
    { path: "/help-center", priority: 0.5, changeFrequency: "monthly" },
    { path: "/api-reference", priority: 0.4, changeFrequency: "monthly" },
    { path: "/privacy-policy", priority: 0.3, changeFrequency: "yearly" },
    { path: "/terms-of-service", priority: 0.3, changeFrequency: "yearly" },
  ];

  return routes.map((route) => ({
    url: `${APP_URL}${route.path}`,
    lastModified: new Date(),
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}

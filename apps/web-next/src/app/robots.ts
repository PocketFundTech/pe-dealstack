import type { MetadataRoute } from "next";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://lmmos.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Authenticated app surfaces and auth flows — nothing to index,
        // and crawling them wastes crawl budget the marketing pages need.
        disallow: [
          "/dashboard",
          "/deals",
          "/data-room",
          "/contacts",
          "/memo-builder",
          "/templates",
          "/deal-intake",
          "/settings",
          "/admin",
          "/graphs",
          "/nda",
          "/onboarding",
          "/portal",
          "/upload",
          "/api",
        ],
      },
    ],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}

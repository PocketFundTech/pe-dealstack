"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * Web Vitals reporter (Phase 1 instrumentation).
 *
 * Captures Core Web Vitals (LCP, INP, CLS, FCP, TTFB) on real user
 * navigations so page-load performance can actually be measured instead of
 * guessed. Mounted once in the root layout.
 *
 * Where the metrics go:
 *  - Always logged to the browser console (grouped, prefixed `[web-vitals]`)
 *    so a developer can read them live in DevTools on prod or local.
 *  - If `NEXT_PUBLIC_VITALS_ENDPOINT` is set, each metric is also POSTed there
 *    via `navigator.sendBeacon` (fire-and-forget, never blocks the page) so
 *    they can be aggregated in any analytics sink.
 *
 * Richer option (not added here to avoid an unverified dependency): install
 * `@vercel/speed-insights` and render `<SpeedInsights />` for Vercel's hosted
 * p75 dashboards. See docs/PAGE-LOAD-PERFORMANCE-TODO.md → Phase 1.
 */
export function WebVitals() {
  useReportWebVitals((metric) => {
    // Console: easy to read live in DevTools.
    console.info(
      `[web-vitals] ${metric.name} = ${Math.round(metric.value)} (${metric.rating})`,
      metric,
    );

    // Optional beacon to an analytics endpoint, if configured.
    const endpoint = process.env.NEXT_PUBLIC_VITALS_ENDPOINT;
    if (endpoint && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      try {
        const body = JSON.stringify({
          name: metric.name,
          value: metric.value,
          rating: metric.rating,
          id: metric.id,
          path: window.location.pathname,
          ts: Date.now(),
        });
        navigator.sendBeacon(endpoint, body);
      } catch {
        // Never let instrumentation break the page.
      }
    }
  });

  return null;
}

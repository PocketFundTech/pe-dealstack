/**
 * pickBundle() decides which compiled Express bundle (lite vs ai) serves a
 * given /api/* path. A path routed to a bundle that doesn't mount its router
 * 404s in production only (local dev runs the full app.ts) — see the
 * 2026-08-14 verification-report defects D2–D4.
 */
import { describe, it, expect } from "vitest";
import { pickBundle } from "./api-routing";

describe("pickBundle", () => {
  it.each([
    // AI bundle — heavy LLM paths
    ["/api/ai/status", "ai"],
    ["/api/deals/123/chat", "ai"],
    ["/api/deals/123/financials/extract", "ai"],
    ["/api/deals/123/scorecard", "ai"], // D3 regression: scorecard runs trackedClaudeMessage
    ["/api/memos/abc/sections", "ai"],
    ["/api/ingest", "ai"],
    ["/api/onboarding/enrich-firm", "ai"],
    ["/api/cron/signal-scan", "ai"], // nightly Vercel cron — signal agent lives in the ai bundle
    ["/api/cron/doc-request-reminders", "ai"], // makes no LLM call, but /api/cron/* is an ai-bundle rule
    ["/api/webhooks/managed-agents", "ai"], // raw-body webhook mounted in app-ai
    // Lite bundle — CRUD paths
    ["/api/deals", "lite"],
    ["/api/deals/123", "lite"],
    ["/api/deals/123/shares", "lite"], // D4 regression: share-link CRUD
    ["/api/deals/123/doc-requests", "lite"], // doc-request CRUD is mounted in app-lite
    ["/api/organizations/criteria", "lite"], // D2 regression: investment criteria
    ["/api/public/portal/sometoken", "lite"], // public portal read
    ["/api/public/doc-requests/sometoken", "lite"], // public broker upload page
    ["/api/contacts", "lite"],
    ["/api/users/me", "lite"],
  ])("%s → %s", (pathname, bundle) => {
    expect(pickBundle(pathname)).toBe(bundle);
  });
});

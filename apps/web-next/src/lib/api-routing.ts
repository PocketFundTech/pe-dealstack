// Decide which compiled Express bundle handles a given pathname. Extracted
// from api-bundles.ts so tests can import the pure function without Vite
// trying to resolve that module's lazy `apps/api/dist/*` imports (which only
// exist after the api build).
//
// Routing rules (mirrors the legacy vercel.json rewrite list, plus the V2
// routes added 2026-08-14):
//   /api/ai/*                                              → ai
//   /api/deals/:id/{chat,generate-thesis,analyze-risks,
//     ai-cache,conversations/*,financials*,scorecard,
//     rescore,nda-reviews}                                  → ai
//   /api/documents/:id/extract-financials                  → ai
//   /api/conversations(/*)?                                → ai
//   /api/memos/*                                           → ai
//   /api/ingest(/*)?                                       → ai
//   /api/onboarding(/*)?                                   → ai
//   /api/cron/*                                            → ai (signal-scan cron)
//   /api/webhooks/managed-agents(/*)?                      → ai (raw-body webhook)
//   everything else under /api/*                           → lite
//
// A path routed to a bundle that doesn't mount its router 404s in
// production only — keep this list in sync with the app-lite.ts / app-ai.ts
// mounts (pinned by apps/api/tests/bundle-route-parity.test.ts and
// api-bundles.test.ts).
const AI_DEAL_SUFFIX_RE =
  /^\/api\/deals\/[^/]+\/(chat|generate-thesis|analyze-risks|ai-cache|conversations|financials|scorecard|rescore|nda-reviews)(\/|$)/;
const AI_DOC_EXTRACT_RE =
  /^\/api\/documents\/[^/]+\/extract-financials\/?$/;

export function pickBundle(pathname: string): "ai" | "lite" {
  if (pathname === "/api/ai" || pathname.startsWith("/api/ai/")) return "ai";
  if (AI_DEAL_SUFFIX_RE.test(pathname)) return "ai";
  if (AI_DOC_EXTRACT_RE.test(pathname)) return "ai";
  if (pathname === "/api/conversations" || pathname.startsWith("/api/conversations/"))
    return "ai";
  if (pathname === "/api/memos" || pathname.startsWith("/api/memos/")) return "ai";
  if (pathname === "/api/ingest" || pathname.startsWith("/api/ingest/"))
    return "ai";
  if (pathname === "/api/onboarding" || pathname.startsWith("/api/onboarding/"))
    return "ai";
  if (pathname.startsWith("/api/cron/")) return "ai";
  if (
    pathname === "/api/webhooks/managed-agents" ||
    pathname.startsWith("/api/webhooks/managed-agents/")
  )
    return "ai";
  return "lite";
}

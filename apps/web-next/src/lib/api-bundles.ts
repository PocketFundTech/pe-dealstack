// Lazy-load the two compiled Express bundles via plain dynamic import().
// Without /* webpackIgnore */ the tracer still follows the import path at
// build time, so apps/api/dist/* and every transitive require (express,
// helmet, supabase, sentry, ...) get packaged into the lambda. Lazy is
// required because app-lite.js / app-ai.js initialise Supabase + LLM
// clients at module load and throw if env vars are missing — running that
// during Next's page-data collection breaks the build. First request on
// the live lambda triggers the load instead, where env vars are present.

import type { ExpressHandler } from "./api-adapter";

type BundleModule = { default: ExpressHandler } | ExpressHandler;

function resolveDefault(mod: unknown): ExpressHandler {
  const candidate =
    (mod as { default?: ExpressHandler }).default ?? (mod as ExpressHandler);
  return candidate;
}

let liteAppPromise: Promise<ExpressHandler> | null = null;
let aiAppPromise: Promise<ExpressHandler> | null = null;

export function getLiteApp(): Promise<ExpressHandler> {
  if (!liteAppPromise) {
    liteAppPromise = import("../../../api/dist/app-lite.js").then(
      (m) => resolveDefault(m as BundleModule),
    );
  }
  return liteAppPromise;
}

export function getAiApp(): Promise<ExpressHandler> {
  if (!aiAppPromise) {
    aiAppPromise = import("../../../api/dist/app-ai.js").then(
      (m) => resolveDefault(m as BundleModule),
    );
  }
  return aiAppPromise;
}

// pickBundle lives in api-routing.ts (pure function, no dist imports) so it
// stays unit-testable; re-exported here to keep the route handler's single
// import site unchanged.
export { pickBundle } from "./api-routing";

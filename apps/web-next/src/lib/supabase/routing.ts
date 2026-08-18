// Pure pathname classifier used by the auth middleware. Kept separate so the
// routing rules can be unit-tested without spinning up a Supabase session.

const AUTH_PAGE_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/accept-invite",
];

// Public marketing/legal pages that anonymous users must be able to reach
// (e.g. linked from the signup flow for GDPR consent, and the public-facing
// marketing pages — pricing, docs, etc.).
const PUBLIC_PAGE_PREFIXES = [
  "/privacy-policy",
  "/terms-of-service",
  "/security",
  "/portal", // external deal-share portal — token IS the credential
  "/upload", // broker/seller document-request upload — token IS the credential

  "/pricing",
  "/documentation",
  "/api-reference",
  "/help-center",
  "/solutions",
  "/resources",
  "/company",
];

const SYSTEM_PREFIXES = ["/api", "/_next"];

const AUTH_ONLY_PAGES = ["/login", "/signup"];

/** Check if pathname matches a prefix exactly or continues with "/" or "?" */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix + "?");
}

/**
 * Does this pathname require an authenticated user? Used by middleware.ts to
 * decide whether to redirect anon users to /login.
 *
 * Returns false for: root ("/"), auth pages, /api, /_next, and any path
 * containing a "." (static assets like favicon.svg, images, etc.).
 */
export function isAppRouteRequiringAuth(pathname: string): boolean {
  if (pathname === "/") return false;
  if (AUTH_PAGE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return false;
  if (PUBLIC_PAGE_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return false;
  if (SYSTEM_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) return false;
  if (pathname.includes(".")) return false;
  return true;
}

/**
 * Is this a page that authenticated users should be redirected away from?
 * Currently just login and signup — auth/reset flows stay accessible even when
 * logged in (e.g., for users changing their password mid-session).
 */
export function isAuthOnlyPage(pathname: string): boolean {
  return AUTH_ONLY_PAGES.some((page) => matchesPrefix(pathname, page));
}

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAppRouteRequiringAuth, isAuthOnlyPage } from "./routing";

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Only two route classes need the Supabase auth call: app routes (redirect
  // anon users to /login) and auth-only pages (redirect signed-in users to
  // /dashboard). Public/marketing/legal pages need neither — so we skip the
  // getUser() network round-trip entirely on those navigations instead of
  // paying it on every page load. getUser() still runs (and refreshes the
  // session cookie) for the routes that actually gate on it.
  const needsAuthGate = isAppRouteRequiringAuth(pathname);
  const redirectAwayWhenSignedIn = isAuthOnlyPage(pathname);
  if (!needsAuthGate && !redirectAwayWhenSignedIn) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase env vars missing — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }

  const supabase = createServerClient(
    url,
    key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Validate the session. getClaims() verifies the JWT signature LOCALLY when
  // the project uses asymmetric signing keys (no network round-trip) and only
  // falls back to a getUser() network call for legacy HS256 tokens — so it is
  // never slower than getUser() and is faster once asymmetric keys are enabled.
  // It still refreshes an expiring access token, because getClaims() delegates
  // to getSession(), which calls _callRefreshToken() on expiry and rotates the
  // cookie via the setAll handler above. So sessions are not dropped.
  const { data: claimsData } = await supabase.auth.getClaims();
  const user = claimsData?.claims ?? null;

  if (!user && needsAuthGate) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && redirectAwayWhenSignedIn) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

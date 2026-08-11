import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Only run the auth middleware on real page navigations. Exclude:
    //  - api/*    the API verifies its own Bearer JWT on every request, so a
    //             middleware getUser() round-trip here was pure overhead added
    //             to EVERY client data fetch.
    //  - _next/*  framework chunks, images, and RSC data payloads.
    //  - any path with a file extension (favicon.svg, images, fonts, …).
    "/((?!api/|_next/static|_next/image|_next/data|favicon.svg|.*\\.).*)",
  ],
};

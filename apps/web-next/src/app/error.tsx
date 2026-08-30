"use client";

import { ErrorFallback } from "@/components/ErrorFallback";

// Boundary for the root segment (marketing / legal / docs pages). Errors in
// the (app), (auth) and (onboarding) groups are caught by their own
// error.tsx; this catches everything else under src/app/*.
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorFallback error={error} reset={reset} />;
}

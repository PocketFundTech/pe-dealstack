"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Shared error-boundary fallback UI.
 *
 * Used by the route-segment `error.tsx` boundaries ((app), (auth),
 * (onboarding), root). It does two things every boundary needs:
 *   1. Reports the error to Sentry — client render errors caught by an
 *      error.tsx boundary are NOT auto-captured (only server request errors
 *      are, via instrumentation `onRequestError`), so without this they never
 *      reach Sentry.
 *   2. Renders a calm, on-brand recovery screen with a "Try again" action.
 *
 * `global-error.tsx` can't use this (it must render its own <html>/<body>), so
 * it duplicates the minimal version with inline styles.
 */
export function ErrorFallback({
  error,
  reset,
  title = "Something went wrong",
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  title?: string;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h2 className="mb-2 text-xl font-semibold text-primary">{title}</h2>
        <p className="mb-6 text-sm text-gray-600">
          {error?.message || "An unexpected error occurred."}
          {error?.digest ? ` (ref: ${error.digest})` : ""}
        </p>
        {reset && (
          <button
            onClick={reset}
            className="rounded-md px-4 py-2 text-sm font-medium text-white"
            style={{ backgroundColor: "#003366" }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

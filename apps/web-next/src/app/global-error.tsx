"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort boundary: catches errors thrown by the ROOT layout itself
 * (where the normal error.tsx boundaries can't help, because they render
 * inside that layout). It replaces the whole document, so it must provide its
 * own <html>/<body> and can't rely on globals.css — hence inline styles.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F8F9FA",
          fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", padding: 32 }}>
          <h2 style={{ color: "#003366", fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
            Something went wrong
          </h2>
          <p style={{ color: "#4b5563", fontSize: 14, margin: "0 0 24px" }}>
            A critical error occurred. Please try again
            {error?.digest ? ` (ref: ${error.digest})` : ""}.
          </p>
          <button
            onClick={reset}
            style={{
              background: "#003366",
              color: "#fff",
              border: 0,
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

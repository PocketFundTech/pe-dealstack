import path from "node:path";
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Resolve the repo root from the working directory rather than __dirname.
// Next 16.x loads .ts configs through an ESM path on Vercel where __dirname
// is undefined; passing undefined into path.join(...) throws
// "TypeError: The "path" argument must be of type string. Received undefined"
// at Vercel's modifyConfig step, breaking the build. process.cwd() is
// always defined (it's apps/web-next when Next runs the build) so
// resolve("..", "..") from there points at the same repo root that
// __dirname used to.
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

// Dev-only proxy: forward /api/* to the local Express API on :3001 so client
// fetches stay same-origin. In prod on Vercel the API is co-located as a
// Vercel Function (api/index.ts) and reached via vercel.json rewrites — no
// Next.js rewrite needed. Pointing this at the same Vercel domain triggers
// DNS_HOSTNAME_RESOLVED_PRIVATE (Vercel blocks self-loops) and 404s /api/*.
const nextConfig: NextConfig = {
  // npm workspaces hoist node_modules to the repo root. Without this, Next's
  // file tracer scopes to apps/web-next/ and misses next/dist/compiled/* on
  // Vercel, breaking the lambda packaging step (ENOENT on @opentelemetry/api).
  outputFileTracingRoot: REPO_ROOT,
  // Tell Next/webpack not to try to bundle Express + its node-side deps —
  // they're full of dynamic requires and platform-specifics that don't
  // bundle cleanly. With these external, the tracer follows the imports
  // and packages the matching node_modules into the lambda automatically.
  serverExternalPackages: [
    "express",
    "helmet",
    "cors",
    "multer",
    "compression",
    "dotenv",
    "express-rate-limit",
    "@sentry/node",
    "@supabase/supabase-js",
    "@anthropic-ai/sdk",
    "openai",
    "@google/generative-ai",
    "@langchain/core",
    "@langchain/google-genai",
    "@langchain/langgraph",
    "@langchain/openai",
    "@llamaindex/cloud",
    "@azure/ai-form-recognizer",
    "apify-client",
    "csv-parse",
    "mailparser",
    "mammoth",
    "marked",
    "sanitize-html",
    "pdf-parse",
    "pino",
    "pino-pretty",
    "resend",
    "xlsx",
    "zod",
  ],
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
    // Google Picker intake (NDA "bring your own Google Doc" flow). These power
    // the browser-side Picker + GIS token client in app/(app)/nda/googlePicker.ts.
    // All three must be set for the "Choose from Google Drive" button to enable;
    // see .env.example for what each value is.
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "",
    NEXT_PUBLIC_GOOGLE_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_API_KEY || "",
    NEXT_PUBLIC_GOOGLE_APP_ID: process.env.NEXT_PUBLIC_GOOGLE_APP_ID || "",
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Google Identity Services + the Drive Picker open an OAuth popup and
          // then call window.close()/poll window.closed on it. Under the default
          // (or a stricter same-origin) COOP those cross-window calls are severed
          // — Chrome logs "Cross-Origin-Opener-Policy policy would block the
          // window.close call" and the picker's token callback never fires.
          // `same-origin-allow-popups` keeps this document isolated from any
          // cross-origin opener while still letting the popups WE open talk back.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") {
      return [];
    }
    const apiProxy = process.env.API_PROXY_URL ?? "http://localhost:3001";
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxy}/api/:path*`,
      },
    ];
  },
};

// Sentry's webpack plugin wraps the config to upload source maps and inject
// release info at build time. Skip the wrap entirely when SENTRY_ORG /
// SENTRY_PROJECT aren't set — passing `undefined` for those into the
// plugin in newer Sentry versions can land them in path-joining code paths
// that Vercel's modifyConfig step rejects with
// "path argument must be of type string. Received undefined". When the env
// is set, the wrap proceeds as before.
const sentryConfigured = Boolean(process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

export default sentryConfigured
  ? withSentryConfig(nextConfig, {
      silent: true,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      widenClientFileUpload: true,
      reactComponentAnnotation: { enabled: true },
      // v9's `hideSourceMaps` became `sourcemaps.deleteSourcemapsAfterUpload`
      // in v10 — same intent: upload maps to Sentry, then strip them from the
      // public bundle so they aren't browsable from prod.
      sourcemaps: { deleteSourcemapsAfterUpload: true },
      disableLogger: true,
    })
  : nextConfig;

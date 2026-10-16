// Redirect-only shim — fresh users get bounced to /onboarding when the dashboard mounts. Originally a modal; the modal UI now lives in (onboarding)/onboarding/page.tsx.
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

// Matches the actual GET /onboarding/status response shape in
// apps/api/src/routes/onboarding.ts (DEFAULT_STATUS line 12-36).
interface OnboardingStatus {
  welcomeShown?: boolean;
  checklistDismissed?: boolean;
  steps?: Record<string, boolean>;
  context?: { searchSetupStatus?: string; invited?: boolean; isAdmin?: boolean };
}

export function WelcomeModal() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // sessionStorage backup — matches c987ade "prevent redirect loop with
      // sessionStorage backup". If the API flakes, the flag keeps us from
      // shuttling the user to /onboarding on every render.
      try {
        if (sessionStorage.getItem("pe_onboarding_seen") === "1") return;
      } catch (err) {
        // sessionStorage disabled (private mode, strict blockers) — fall
        // through to the API check below.
        console.warn("[onboarding/WelcomeModal] sessionStorage read failed:", err);
      }

      try {
        const status = await api.get<OnboardingStatus>("/onboarding/status");
        if (cancelled) return;
        if (status.context?.isAdmin && !status.context.invited && ['complete','skipped'].includes(status.context.searchSetupStatus || '')) return;

        // New flow — if user hasn't seen the welcome, hasn't dismissed the
        // checklist, and has no completed steps yet, send them to /onboarding.
        // Matches 994b094 ("skip old welcome modal for users who went through
        // new flow"): the new flow replaces the legacy welcome entirely for
        // fresh users.
        const hasAnyProgress = !!status.steps && Object.values(status.steps).some((v) => v === true);
        if (!status.welcomeShown && !status.checklistDismissed && !hasAnyProgress) {
          router.push("/onboarding");
          return;
        }

        // Pre-existing user — cache "seen" so subsequent loads skip the API
        // call entirely (works around transient /onboarding/status 5xx and
        // race conditions with the DB welcomeShown flag update).
        if (status.welcomeShown || status.checklistDismissed || hasAnyProgress) {
          try {
            sessionStorage.setItem("pe_onboarding_seen", "1");
          } catch (err) {
            // sessionStorage disabled — non-critical.
            console.warn("[onboarding/WelcomeModal] sessionStorage write failed:", err);
          }
        }
      } catch (err) {
        // Best-effort onboarding status fetch.
        console.warn("[onboarding/WelcomeModal] failed to load status:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}

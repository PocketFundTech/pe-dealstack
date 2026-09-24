"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { OutreachContact } from "./types";

// ---------------------------------------------------------------------------
// "Stale" is a cross-cutting computed view over the board's existing
// `contacts` array — NOT a real OutreachStage a contact ever gets moved
// into. A contact counts as stale when it hasn't been touched (any PATCH,
// including a stage move) in more than `staleDays` days, regardless of
// which real pipeline stage it's actually sitting in right now.
//
// `staleDays` is org-configurable (see apps/api/src/routes/outreach-
// settings.ts and the settings page's OutreachPipelineSection.tsx, built in
// parallel) — fetched once here rather than hardcoded so this stays in
// sync with whatever an admin sets. If the settings endpoint isn't
// reachable for any reason (not deployed yet, network blip, whatever),
// fall back to the hardcoded default rather than breaking the board over a
// config fetch.
//
// Pulled out of OutreachBoard.tsx (already at the repo's 500-line soft cap)
// rather than grown inline — same reasoning as the CsvImportButton/
// OutreachToolbar/useOutreachSelection/useOutreachSend/useOutreachReviewFlags
// extractions before it.
// ---------------------------------------------------------------------------

const DEFAULT_STALE_DAYS = 21;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function useOutreachStaleness(contacts: OutreachContact[]) {
  const [staleDays, setStaleDays] = useState(DEFAULT_STALE_DAYS);
  // `Date.now()` is impure and can't be called directly during render (React's
  // purity rule — this repo's lint enforces it as a hard error, not a style
  // nit: "Cannot call impure function during render"). A lazy initializer
  // (the `() => Date.now()` form) is the compliant way to seed one-time
  // non-deterministic state — it runs once at mount, not on every render, so
  // it's exempt; a plain `useEffect(() => setNow(Date.now()), [])` was tried
  // first and rejected by a second rule (react-hooks/set-state-in-effect —
  // "avoid calling setState() directly within an effect"). "Now" is
  // deliberately a one-time snapshot from when the board loaded, not a live
  // clock — good enough for a stale-contacts view that only needs to be
  // roughly right, and avoids needing an interval to keep it fresh.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.get<{ staleDays: number }>("/outreach/settings");
        if (!cancelled && typeof settings?.staleDays === "number") {
          setStaleDays(settings.staleDays);
        }
      } catch (err) {
        // Not fatal — the settings endpoint may not be deployed yet, or the
        // call may have failed for some other reason. Keep the hardcoded
        // default rather than breaking the board over a config fetch; log
        // so a silent misconfiguration is at least visible in devtools.
        console.warn("Failed to load outreach settings; falling back to default staleDays", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const staleContacts = contacts.filter((c) => {
    const updatedAt = new Date(c.updatedAt).getTime();
    if (Number.isNaN(updatedAt)) return false;
    return now - updatedAt > staleDays * MS_PER_DAY;
  });

  return { staleDays, staleContacts };
}

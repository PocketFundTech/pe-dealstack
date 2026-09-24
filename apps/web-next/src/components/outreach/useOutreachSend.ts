"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/providers/ToastProvider";
import type { OutreachContact, SendContactResult } from "./types";

// ---------------------------------------------------------------------------
// Owns the SendConfirmModal's open/closed state and the actual send
// fan-out — used identically for a single contact (Send from a card/the
// detail modal — caller passes a one-element array) and bulk send (caller
// passes the full selection). One code path for both, since the eligibility
// filter and batching logic are the same either way; no reason to duplicate
// it the way the manual-Enrich-route/bulk-import-auto-enrich split
// (apps/api/src/routes/outreach.ts vs outreachEnrichment.ts) ended up doing
// on the backend.
//
// Batch size is small (3) and this is NOT client-side-parallel the way
// bulk move/enrich are — each call is a REAL Reply.io enrollment, not an
// idempotent read or a safe-to-retry DB write, so keeping the fan-out
// modest is about not hammering a live external system on a real send, not
// about a timeout risk (there isn't one here — see useOutreachSelection.ts's
// bulkEnrich comment for why client-side fan-out doesn't have the import
// route's server-timeout problem regardless of batch size).
// ---------------------------------------------------------------------------

const BULK_SEND_BATCH_SIZE = 3;

export function useOutreachSend(setContacts: Dispatch<SetStateAction<OutreachContact[]>>) {
  const { showToast } = useToast();
  const [sendModalContacts, setSendModalContacts] = useState<OutreachContact[] | null>(null);
  const [sending, setSending] = useState(false);

  function openSendModal(contacts: OutreachContact[]) {
    if (contacts.length === 0) return;
    setSendModalContacts(contacts);
  }

  function closeSendModal() {
    if (sending) return; // don't let a click-outside/Cancel abandon an in-flight send
    setSendModalContacts(null);
  }

  async function confirmSend(campaignId: string) {
    const targets = (sendModalContacts || []).filter((c) => c.email);
    if (targets.length === 0 || sending) return;
    setSending(true);

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < targets.length; i += BULK_SEND_BATCH_SIZE) {
      const batch = targets.slice(i, i + BULK_SEND_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((c) => api.post<SendContactResult>(`/outreach/contacts/${c.id}/send`, { campaignId })),
      );
      for (const result of results) {
        if (result.status !== "fulfilled") {
          failed++;
          continue;
        }
        const value = result.value;
        if ("sent" in value) {
          // SendNotRunResult — Reply.io not configured, or a precondition
          // failed (e.g. email cleared between load and send). Not the
          // common case (eligibility was already filtered client-side),
          // but handled rather than silently miscounted as "sent".
          failed++;
          continue;
        }
        sent++;
        const updated = value;
        setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      }
    }

    setSending(false);
    setSendModalContacts(null);

    if (failed === 0) {
      showToast(`Sent ${sent} contact${sent !== 1 ? "s" : ""} via Reply.io`, "success");
    } else {
      showToast(`Sent ${sent}, ${failed} failed`, sent > 0 ? "warning" : "error");
    }
  }

  return { sendModalContacts, sending, openSendModal, closeSendModal, confirmSend };
}

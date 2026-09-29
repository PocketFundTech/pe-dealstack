"use client";

// ---------------------------------------------------------------------------
// IngestDealModalProvider — exposes a single modal instance and an
// `openDealIntake()` helper to all (app) routes. Mounted once at the (app)
// layout root alongside CommandPalette so any trigger (Header CTA, command
// palette action, dashboard quick-action, deals page UploadCard) can open
// the modal without prop drilling.
// ---------------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { IngestDealModal } from "@/components/deal-intake/IngestDealModal";
import type { DealOption } from "@/app/(app)/deal-intake/components";

interface IngestDealModalContextValue {
  /** Pass a deal to open the modal pre-scoped to "Update Existing Deal" for
   *  that deal (e.g. from a deal detail page's "Add Document" action). Omit
   *  to open in the default "Create New Deal" mode. */
  openDealIntake: (deal?: DealOption) => void;
  closeDealIntake: () => void;
}

const IngestDealModalContext = createContext<IngestDealModalContextValue | null>(null);

export function IngestDealModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [preselectedDeal, setPreselectedDeal] = useState<DealOption | null>(null);

  const openDealIntake = useCallback((deal?: DealOption) => {
    // Callers often pass this straight to onClick, so it receives the click
    // event. Only a real deal (string id) opens in "Update Existing Deal" mode.
    setPreselectedDeal(deal && typeof deal.id === "string" ? deal : null);
    setOpen(true);
  }, []);
  const closeDealIntake = useCallback(() => {
    setOpen(false);
    setPreselectedDeal(null);
  }, []);

  return (
    <IngestDealModalContext.Provider value={{ openDealIntake, closeDealIntake }}>
      {children}
      <IngestDealModal open={open} onClose={closeDealIntake} preselectedDeal={preselectedDeal} />
    </IngestDealModalContext.Provider>
  );
}

export function useIngestDealModal(): IngestDealModalContextValue {
  const ctx = useContext(IngestDealModalContext);
  if (!ctx) {
    // Defensive fallback — outside the provider (e.g. /deal-intake page itself,
    // which renders the form directly), opening just navigates as a hard link.
    return {
      openDealIntake: () => {
        if (typeof window !== "undefined") window.location.href = "/deal-intake";
      },
      closeDealIntake: () => {},
    };
  }
  return ctx;
}

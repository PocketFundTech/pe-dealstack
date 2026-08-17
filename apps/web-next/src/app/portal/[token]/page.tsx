"use client";

// Public external portal page — /portal/[token]. No auth: the share token is
// the credential. Deliberately uses plain fetch, NOT lib/api.ts (which
// attaches auth headers and redirects to /login on 401).

import { use, useEffect, useState } from "react";
import { PortalView, type PortalState, type PortalPayload } from "../portal-view";

export default function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<PortalState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/portal/${token}`);
        if (cancelled) return;
        if (res.status === 410) {
          const body = await res.json().catch(() => ({}));
          setState({ status: "gone", message: body.error || "This link has been revoked or has expired." });
          return;
        }
        if (!res.ok) {
          setState({ status: "notfound" });
          return;
        }
        const payload = (await res.json()) as PortalPayload;
        setState({ status: "ready", payload });
      } catch (err) {
        console.warn("portal load failed", err);
        if (!cancelled) setState({ status: "notfound" });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return <PortalView state={state} token={token} />;
}

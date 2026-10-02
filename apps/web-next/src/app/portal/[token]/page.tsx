"use client";

// Public external portal page — /portal/[token]. No auth: the share token is
// the credential. Deliberately uses plain fetch, NOT lib/api.ts (which
// attaches auth headers and redirects to /login on 401).

import { use, useEffect, useState } from "react";
import { PortalView, type PortalState, type PortalPayload } from "../portal-view";

type PortalResult = { status: number; body: unknown };

// One request per page open. React dev / Strict Mode runs effects twice, and
// every portal fetch records a view — so without this each open counted
// twice. The in-flight promise is shared, then dropped once it settles.
const inflight = new Map<string, Promise<PortalResult>>();
function loadPortal(token: string): Promise<PortalResult> {
  let p = inflight.get(token);
  if (!p) {
    p = fetch(`/api/public/portal/${token}`)
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
      .finally(() => { setTimeout(() => inflight.delete(token), 0); });
    inflight.set(token, p);
  }
  return p;
}

export default function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<PortalState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await loadPortal(token);
        if (cancelled) return;
        if (res.status === 410) {
          const body = res.body as { error?: string };
          setState({ status: "gone", message: body.error || "This link has been revoked or has expired." });
          return;
        }
        if (res.status < 200 || res.status >= 300) {
          setState({ status: "notfound" });
          return;
        }
        setState({ status: "ready", payload: res.body as PortalPayload });
      } catch (err) {
        console.warn("portal load failed", err);
        if (!cancelled) setState({ status: "notfound" });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return <PortalView state={state} token={token} />;
}

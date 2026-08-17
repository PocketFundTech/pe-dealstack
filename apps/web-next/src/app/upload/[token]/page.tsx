"use client";

// Public document-upload page — /upload/[token]. No auth: the DocRequest
// token is the credential. Deliberately uses plain fetch, NOT lib/api.ts
// (which attaches auth headers and redirects to /login on 401) — same
// reasoning as portal/[token]/page.tsx.

import { use, useEffect, useState } from "react";
import { UploadView, type UploadState, type UploadPayload } from "./upload-view";

export default function UploadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<UploadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/doc-requests/${token}`);
        if (cancelled) return;
        if (res.status === 410) {
          const body = await res.json().catch(() => ({}));
          setState({
            status: "gone",
            message: body.error || "This link has been revoked or has expired.",
          });
          return;
        }
        if (!res.ok) {
          setState({ status: "notfound" });
          return;
        }
        const payload = (await res.json()) as UploadPayload;
        setState({ status: "ready", payload });
      } catch (err) {
        console.warn("doc request load failed", err);
        if (!cancelled) setState({ status: "notfound" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return <UploadView state={state} token={token} />;
}

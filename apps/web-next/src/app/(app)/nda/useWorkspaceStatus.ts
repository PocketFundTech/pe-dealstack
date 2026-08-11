"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface WorkspaceStatus {
  loading: boolean;
  connected: boolean;
  // True only for managed Google Workspace accounts (from the OAuth `hd`
  // hosted-domain claim). Gates the Google Docs native eSignature actions.
  isWorkspace: boolean;
  email: string | null;
}

interface WorkspaceEmailResponse {
  email: string | null;
  connected: boolean;
  isWorkspace?: boolean;
}

/**
 * Fetches the connected Google account status from /auth/workspace-email once
 * on mount. Used by the NDA UI to grey out the Google-Docs-eSignature-only
 * actions (Request Signature, import-for-signing) for personal accounts.
 */
export function useWorkspaceStatus(): WorkspaceStatus {
  const [status, setStatus] = useState<WorkspaceStatus>({
    loading: true,
    connected: false,
    isWorkspace: false,
    email: null,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .get<WorkspaceEmailResponse>("/auth/workspace-email")
      .then((r) => {
        if (cancelled) return;
        setStatus({
          loading: false,
          connected: Boolean(r.connected),
          isWorkspace: Boolean(r.isWorkspace),
          email: r.email ?? null,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({ loading: false, connected: false, isWorkspace: false, email: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

// Data-loading hooks extracted from page.tsx so the page itself stays under
// the 500-line cap. Each hook wraps one of the original useEffect blocks
// without changing its timing or side effects.

import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import {
  fetchDeal,
  fetchDocuments,
  fetchFolderInsights,
  fetchFolders,
  initializeDealFolders,
  transformDocument,
  transformFolder,
  transformInsights,
} from "@/lib/vdr/api";
import type { APIFolder, Folder, FolderInsights, VDRFile } from "@/lib/vdr/types";
import { onDealsChanged } from "@/lib/appEvents";

type TeamMembers = Array<{ id: string; role: string; user?: { name?: string; avatar?: string; email?: string } }>;

interface UseInitialLoadArgs {
  dealId: string;
  activeFolderId: string | null;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setDealName: Dispatch<SetStateAction<string>>;
  setTeamMembers: Dispatch<SetStateAction<TeamMembers>>;
  setFolders: Dispatch<SetStateAction<Folder[]>>;
  setActiveFolderId: Dispatch<SetStateAction<string | null>>;
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
}

// Initial load: deal name + folders (init if empty) + documents.
// Mirrors the inline useEffect in page.tsx including the
// `eslint-disable-next-line react-hooks/exhaustive-deps` semantics — we only
// re-run on dealId changes, not on activeFolderId, intentionally.
export function useInitialLoad({
  dealId,
  activeFolderId,
  setLoading,
  setDealName,
  setTeamMembers,
  setFolders,
  setActiveFolderId,
  setAllFiles,
}: UseInitialLoadArgs) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [dealData, apiFolders] = await Promise.all([
          fetchDeal(dealId),
          fetchFolders(dealId),
        ]);
        if (cancelled) return;

        if (dealData?.name) setDealName(dealData.name);
        if ((dealData as Record<string, unknown>)?.teamMembers) {
          setTeamMembers((dealData as Record<string, unknown>).teamMembers as TeamMembers);
        }

        let folderList: APIFolder[] = apiFolders;
        if (folderList.length === 0) {
          const init = await initializeDealFolders(dealId);
          if (cancelled) return;
          folderList = init.folders;
        }
        const transformed = folderList.map(transformFolder);
        setFolders(transformed);
        if (transformed.length > 0 && !activeFolderId) {
          setActiveFolderId(transformed[0].id);
        }

        // Load all documents across the deal so smart-filter search works globally
        const docs = await fetchDocuments(dealId);
        if (cancelled) return;
        setAllFiles(docs.map(transformDocument));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  // Refresh just the document list when an ingest reports this deal changed
  // (e.g. a Google Drive import into this deal via the ingest modal) or when the
  // tab regains focus (covers the background Gmail sync). Deliberately does NOT
  // touch loading/folders/deal-name — only the file list goes stale on ingest —
  // so a background refresh doesn't flash the whole page.
  useEffect(() => {
    let cancelled = false;
    const reloadDocuments = async () => {
      try {
        const docs = await fetchDocuments(dealId);
        if (!cancelled) setAllFiles(docs.map(transformDocument));
      } catch (err) {
        console.warn("[data-room] document refresh failed:", err);
      }
    };
    const off = onDealsChanged((detail) => {
      if (!detail.dealId || detail.dealId === dealId) reloadDocuments();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") reloadDocuments();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, setAllFiles]);
}

// AI Quick Insights panel collapse state: the user's explicit choice is
// remembered across visits (localStorage); absent a stored choice, default
// to collapsed on viewports narrower than 1536px so the file table
// (Author/Date/action menu) isn't squeezed into a sliver by the two
// fixed-width sidebars either side of it.
export function useInsightsCollapse(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.vdrInsightsCollapsed);
      if (stored === "true" || stored === "false") {
        setCollapsed(stored === "true");
        return;
      }
    } catch (err) {
      console.warn("[data-room] failed to read insights-collapsed preference:", err);
    }
    if (window.innerWidth < 1536) {
      setCollapsed(true);
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEYS.vdrInsightsCollapsed, String(next));
      } catch (err) {
        console.warn("[data-room] failed to persist insights-collapsed preference:", err);
      }
      return next;
    });
  }, []);

  return [collapsed, toggle];
}

const PROCESSING_POLL_INTERVAL_MS = 5000;

interface UseProcessingPollArgs {
  dealId: string;
  activeFolderId: string | null;
  allFiles: VDRFile[];
  setAllFiles: Dispatch<SetStateAction<VDRFile[]>>;
}

// Uploads now respond as soon as the Document row exists — AI extraction
// (which used to make the upload request itself slow) can still be running
// in the background, reflected as Document.status === 'processing'. While
// any file in the CURRENTLY VIEWED folder is still processing, poll that
// folder's documents every 5s so the row flips to its final analyzed state
// without the user manually refreshing. Stops polling as soon as nothing in
// the folder is processing anymore, and on unmount / folder switch.
export function useProcessingPoll({
  dealId,
  activeFolderId,
  allFiles,
  setAllFiles,
}: UseProcessingPollArgs) {
  // A boolean (not the array itself) as the effect dependency — this only
  // restarts the interval when processing actually starts/stops in this
  // folder, not on every unrelated setAllFiles call (rename, delete, etc.).
  const hasProcessingInFolder = useMemo(
    () =>
      !!activeFolderId &&
      allFiles.some((f) => f.folderId === activeFolderId && f.status === "processing"),
    [allFiles, activeFolderId],
  );

  useEffect(() => {
    if (!activeFolderId || !hasProcessingInFolder) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const docs = await fetchDocuments(dealId, activeFolderId);
        if (cancelled) return;
        const refreshed = docs.map(transformDocument);
        setAllFiles((prev) => [
          ...prev.filter((f) => f.folderId !== activeFolderId),
          ...refreshed,
        ]);
      } catch (err) {
        console.warn("[data-room] processing poll failed:", err);
      }
    }, PROCESSING_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dealId, activeFolderId, hasProcessingInFolder, setAllFiles]);
}

interface UseFolderInsightsArgs {
  activeFolderId: string | null;
  setInsights: Dispatch<SetStateAction<Record<string, FolderInsights>>>;
}

// Load insights for the active folder.
// Tracks which folders we've already attempted to fetch insights for so that
// a 404 (no insights yet) doesn't cause an infinite retry loop. We use a ref
// instead of putting `insights` in the dependency array — the old code had
// `insights` as a dep which caused the effect to re-fire every time the
// state object changed, potentially hammering a 404 endpoint.
export function useFolderInsights({ activeFolderId, setInsights }: UseFolderInsightsArgs) {
  const insightsFetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeFolderId) return;
    if (insightsFetchedRef.current.has(activeFolderId)) return;
    insightsFetchedRef.current.add(activeFolderId);
    (async () => {
      const apiInsight = await fetchFolderInsights(activeFolderId);
      setInsights((prev) => ({
        ...prev,
        [activeFolderId]: transformInsights(apiInsight, activeFolderId),
      }));
    })();
  }, [activeFolderId, setInsights]);
}
